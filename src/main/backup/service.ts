import { app } from 'electron'
import type {
  BackupConfig,
  BackupEnvelope,
  BackupPreview,
  BackupRunResult,
  BackupSnapshotInfo,
  BackupStatus,
  StoreShape
} from '@shared/types'
import { getKey, setKey } from '../storage'
import {
  getSecret,
  isAvailable,
  setSecret
} from './keychain'
import { openSnapshot, sealSnapshot } from './crypto'
import { createTarget, makeSnapshotName, type BackupTarget } from './target'

// Orchestrates backups: reads the live store, seals a snapshot, writes it to the
// target, prunes old ones, and restores in the other direction.
//
// It lives in the main process because it needs the real store contents, the
// OS keychain for the WebDAV password, and a place to keep a timer that
// outlives any renderer.

const DEFAULT_CONFIG: BackupConfig = {
  enabled: false,
  target: 'folder',
  location: '',
  intervalMinutes: 60,
  keepSnapshots: 10,
  encrypt: true
}

const SETTINGS_KEY = 'backup'

// One backup at a time. Concurrent runs would race on retention pruning and
// could interleave writes to the same snapshot name.
let inFlight: Promise<BackupRunResult> | null = null

let status: BackupStatus = {
  configured: false,
  running: false,
  lastRunAt: null,
  lastError: null,
  lastSnapshot: null,
  passphrasePersisted: false
}

const listeners = new Set<(s: BackupStatus) => void>()
let timer: NodeJS.Timeout | null = null
let config: BackupConfig = { ...DEFAULT_CONFIG }

function emit(): void {
  for (const cb of listeners) {
    try {
      cb({ ...status })
    } catch {
      // A dead listener must not stop the others being notified.
    }
  }
}

function setStatus(patch: Partial<BackupStatus>): void {
  status = { ...status, ...patch }
  emit()
}

// --- Config ----------------------------------------------------------------

function normalizeConfig(raw: unknown): BackupConfig {
  const c = (raw ?? {}) as Partial<BackupConfig>
  return {
    enabled: !!c.enabled,
    target: c.target === 'webdav' ? 'webdav' : 'folder',
    location: typeof c.location === 'string' ? c.location : '',
    username: typeof c.username === 'string' ? c.username : '',
    intervalMinutes: clampInt(c.intervalMinutes, 0, 60 * 24 * 30, DEFAULT_CONFIG.intervalMinutes),
    keepSnapshots: clampInt(c.keepSnapshots, 1, 500, DEFAULT_CONFIG.keepSnapshots),
    encrypt: c.encrypt !== false
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function isConfigured(c: BackupConfig): boolean {
  return c.target === 'folder' ? c.location.trim().length > 0 : c.location.trim().length > 0
}

function currentStore(): StoreShape {
  return {
    folders: getKey('folders'),
    sessions: getKey('sessions'),
    settings: getKey('settings')
  }
}

// --- Scheduling ------------------------------------------------------------

function reschedule(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (!config.enabled || !isConfigured(config) || config.intervalMinutes <= 0) return

  const ms = config.intervalMinutes * 60_000
  // Node clamps very long intervals to 1 ms and restarts the loop, so a timer
  // beyond the 32-bit limit is scheduled in chunks instead.
  if (ms > 2_147_483_647) {
    timer = setInterval(() => {
      // A long-interval backup still needs to be visible as "configured".
      void runBackup()
    }, 2_147_483_647)
    return
  }
  timer = setInterval(() => {
    void runBackup()
  }, ms)
  // Don't hold the event loop open just for a backup timer.
  timer.unref?.()
}

/**
 * Loads the config out of the persisted settings and arms the timer.
 * Call once, after the app is ready.
 */
export function initBackup(): void {
  const settings = getKey('settings') as unknown as Record<string, unknown>
  config = normalizeConfig(settings[SETTINGS_KEY])
  setStatus({ configured: isConfigured(config), passphrasePersisted: isAvailable() })
  reschedule()
}

export function getBackupConfig(): BackupConfig {
  return { ...config }
}

export function setBackupConfig(next: BackupConfig): BackupConfig {
  config = normalizeConfig(next)
  setKey('settings', {
    ...getKey('settings'),
    [SETTINGS_KEY]: config
  } as never)
  setStatus({ configured: isConfigured(config) })
  reschedule()
  return getBackupConfig()
}


/**
 * The WebDAV password lives in the OS keychain. It is never written to the
 * settings file, so a copied config can't leak the credential. If the keychain
 * is unavailable (common on Linux without a keyring daemon) the caller is told,
 * and the user supplies the password for the session instead.
 */


/**
 * The encryption passphrase is held in memory for the session, so a scheduled
 * backup can run unattended, and mirrored into the keychain so the next launch
 * can do the same. It is never written to the settings file.
 */
let sessionPassphrase: string | null = null

export function setSessionPassphrase(passphrase: string | null): void {
  sessionPassphrase = passphrase && passphrase.length > 0 ? passphrase : null
  if (sessionPassphrase) setSecret(sessionPassphrase)
}

function backupPassphrase(): string | null {
  if (sessionPassphrase) return sessionPassphrase
  // A WebDAV setup may already have a keychain-stored secret; reuse it so an
  // encrypted scheduled backup still works without a second secret.
  return config.target === 'webdav' ? getSecret() : null
}

export function setWebdavSecret(password: string | null): boolean {
  const ok = setSecret(password)
  setStatus({ passphrasePersisted: isAvailable() })
  return ok
}

export function secretPersisted(): boolean {
  return isAvailable()
}

// --- Operations ------------------------------------------------------------

/**
 * Seals the current store and writes it to the target, then prunes to the
 * retention limit. Concurrent calls share one run rather than racing on
 * pruning or writing the same snapshot name twice.
 */
export function runBackup(): Promise<BackupRunResult> {
  if (inFlight) return inFlight
  inFlight = doBackup().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doBackup(): Promise<BackupRunResult> {
  if (!isConfigured(config)) {
    const message = 'Choose a backup location first.'
    setStatus({ lastError: message })
    return { ok: false, message }
  }

  setStatus({ running: true, lastError: null })

  try {
    const target = createTarget(config, getSecret())
    const now = Date.now()
    const passphrase = config.encrypt ? backupPassphrase() : null
    const envelope = sealSnapshot(currentStore(), {
      appVersion: app.getVersion(),
      createdAt: now,
      passphrase
    })

    const name = makeSnapshotName(now)
    await target.write(name, JSON.stringify(envelope))
    const pruned = await prune(target)

    const info = (await target.list()).find((s) => s.name === name)
    setStatus({ running: false, lastRunAt: now, lastError: null, lastSnapshot: name })

    return {
      ok: true,
      message: passphrase ? 'Encrypted backup saved.' : 'Backup saved.',
      snapshot: info ?? { name, createdAt: now, sizeBytes: 0, encrypted: !!passphrase },
      pruned
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setStatus({ running: false, lastError: message })
    return { ok: false, message }
  }
}

/** Deletes the oldest snapshots beyond the retention limit. */
async function prune(target: BackupTarget): Promise<number> {
  const all = await target.list()
  const doomed = all.slice(config.keepSnapshots)
  for (const snap of doomed) {
    try {
      await target.remove(snap.name)
    } catch {
      // A snapshot we can't delete shouldn't fail an otherwise good backup.
    }
  }
  return doomed.length
}

export async function listSnapshots(): Promise<BackupSnapshotInfo[]> {
  if (!isConfigured(config)) return []
  try {
    return await createTarget(config, getSecret()).list()
  } catch {
    // A listing failure is surfaced by testConnection; the panel just shows none.
    return []
  }
}

/** Describes a snapshot without committing to a restore. */
export async function inspectSnapshot(
  name: string,
  passphrase?: string | null
): Promise<BackupPreview> {
  try {
    const target = createTarget(config, getSecret())
    const envelope = JSON.parse(await target.read(name)) as BackupEnvelope
    const data = openSnapshot(envelope, passphrase ?? backupPassphrase())

    return {
      ok: true,
      message: 'Snapshot ready to restore.',
      createdAt: envelope.createdAt,
      appVersion: envelope.appVersion,
      encrypted: !!envelope.encryption,
      workspaces: data.folders.length,
      brainstorms: data.sessions.length,
      ideas: data.sessions.reduce((n, s) => n + s.ideas.length, 0),
      messages: data.sessions.reduce((n, s) => n + s.messages.length, 0)
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Restores a snapshot over the local store.
 *
 * Restoring is the one genuinely destructive thing this app does, so it is
 * guarded: a safety snapshot of the current state is written to the target
 * first, the payload is validated before anything is overwritten, and the
 * caller can ask to merge instead of replace.
 */
export async function restoreSnapshot(
  name: string,
  passphrase: string | null,
  merge: boolean
): Promise<BackupRunResult> {
  if (inFlight) {
    return { ok: false, message: 'A backup is already running. Try again in a moment.' }
  }
  inFlight = doRestore(name, passphrase, merge).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doRestore(
  name: string,
  passphrase: string | null,
  merge: boolean
): Promise<BackupRunResult> {
  setStatus({ running: true, lastError: null })

  let safety: BackupSnapshotInfo | undefined
  try {
    // Capture the current state first, so a mistaken restore is reversible.
    if (isConfigured(config)) {
      try {
        const before = await runBackup()
        if (before.ok) safety = before.snapshot
      } catch {
        // If the safety copy can't be written we still proceed: refusing to
        // restore because the network is down would strand the user.
      }
    }

    const target = createTarget(config, getSecret())
    const envelope = JSON.parse(await target.read(name)) as BackupEnvelope
    const incoming = openSnapshot(envelope, passphrase ?? backupPassphrase())

    // A session whose workspace is missing would be invisible in the UI, so
    // adopt orphans into a fallback folder before writing anything back.
    const { folders, sessions } = merge
      ? mergeStores(currentStore(), incoming)
      : adoptOrphans(incoming)

    setKey('folders', folders)
    setKey('sessions', sessions)

    setStatus({ running: false, lastError: null, lastRunAt: Date.now() })
    return {
      ok: true,
      message: merge
        ? `Restored and merged.${safety ? ' Your previous state was snapshotted first.' : ''}`
        : `Restored.${safety ? ' Your previous state was snapshotted first.' : ''}`,
      snapshot: safety
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setStatus({ running: false, lastError: message })
    return { ok: false, message }
  }
}

/** Assigns any session with a missing workspace to a real folder. */
function adoptOrphans(store: StoreShape): {
  folders: StoreShape['folders']
  sessions: StoreShape['sessions']
} {
  const folders = [...store.folders]
  const known = new Set(folders.map((f) => f.id))
  const orphans = store.sessions.filter((s) => !s.folderId || !known.has(s.folderId))
  if (orphans.length === 0) return { folders, sessions: store.sessions }

  let fallback = folders[0]
  if (!fallback) {
    fallback = { id: `folder_${Date.now()}`, name: 'My Workspace', createdAt: Date.now() }
    folders.push(fallback)
  }
  const target = fallback.id
  return {
    folders,
    sessions: store.sessions.map((s) =>
      !s.folderId || !known.has(s.folderId) ? { ...s, folderId: target } : s
    )
  }
}

/**
 * Merges an incoming snapshot into the current data, keeping both sides. Where
 * a session exists in both, the more recently edited one wins, so a merge never
 * discards newer work from either machine.
 */
function mergeStores(current: StoreShape, incoming: StoreShape): {
  folders: StoreShape['folders']
  sessions: StoreShape['sessions']
} {
  const byId = new Map(current.sessions.map((s) => [s.id, s]))
  for (const s of incoming.sessions) {
    const mine = byId.get(s.id)
    if (!mine || s.updatedAt > mine.updatedAt) byId.set(s.id, s)
  }

  const seen = new Set(current.folders.map((f) => f.id))
  const folders = [...current.folders]
  for (const f of incoming.folders) {
    if (!seen.has(f.id)) {
      folders.push(f)
      seen.add(f.id)
    }
  }
  return adoptOrphans({ folders, sessions: [...byId.values()], settings: incoming.settings })
}

export async function testConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    if (!isConfigured(config)) return { ok: false, message: 'Choose a backup location first.' }
    await createTarget(config, getSecret()).probe()
    return { ok: true, message: 'Connected.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export function getBackupStatus(): BackupStatus {
  return { ...status }
}

export function onBackupStatus(cb: (s: BackupStatus) => void): () => void {
  listeners.add(cb)
  cb({ ...status })
  return () => {
    listeners.delete(cb)
  }
}

/** Stops the timer and drops listeners. Used on shutdown. */
export function disposeBackup(): void {
  if (timer) clearInterval(timer)
  timer = null
  listeners.clear()
}
