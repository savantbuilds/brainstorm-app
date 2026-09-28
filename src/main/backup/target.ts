import { mkdir, readdir, readFile, writeFile, unlink, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { BackupConfig, BackupSnapshotInfo } from '@shared/types'

// A backup target is somewhere snapshots can be written and read back. Two
// implementations cover the realistic cases without any vendor SDK or OAuth:
//
//   folder  — a directory that some other program syncs (Dropbox, OneDrive,
//             Google Drive, a Syncthing folder). We only touch our own files.
//   webdav  — a Nextcloud / ownCloud / NAS endpoint over HTTP.
//
// Both are dumb: they store opaque bytes and list what is there. Everything
// about interpreting a snapshot lives in crypto.ts and the service, so a new
// transport only has to implement these five methods.

export const SNAPSHOT_EXT = '.brainstorm'
const OWN_PREFIX = 'backup-'

export interface BackupTarget {
  list(): Promise<BackupSnapshotInfo[]>
  write(name: string, contents: string): Promise<void>
  read(name: string): Promise<string>
  remove(name: string): Promise<void>
  /** Cheap reachability probe for the "Test connection" button. */
  probe(): Promise<void>
}

/** Snapshot names are timestamps, which sort lexicographically in time order. */
export function makeSnapshotName(at: number): string {
  return `${OWN_PREFIX}${new Date(at).toISOString().replace(/[:.]/g, '-')}${SNAPSHOT_EXT}`
}

function isSnapshotName(name: string): boolean {
  return name.startsWith(OWN_PREFIX) && name.endsWith(SNAPSHOT_EXT)
}

/** Rejects any name that isn't one of ours, or that contains a path. */
function safeName(name: string): string {
  const base = basename(name)
  if (base !== name || !isSnapshotName(name)) {
    throw new Error('Invalid snapshot name.')
  }
  return name
}

/**
 * Reads only the readable header of a snapshot so the list view can show when
 * it was taken and whether it is encrypted, without a passphrase.
 */
export async function describeSnapshot(name: string, raw: string): Promise<BackupSnapshotInfo> {
  const stamped = /backup-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.brainstorm$/.exec(name)
  let createdAt = stamped ? Date.parse(stamped[1].replace(/-(\d{2})-(\d{2})T/, '-$1-$2T')) : 0
  let encrypted = false
  try {
    const envelope = JSON.parse(raw) as { createdAt?: number; encryption?: unknown }
    if (typeof envelope.createdAt === 'number') createdAt = envelope.createdAt
    encrypted = !!envelope.encryption
  } catch {
    // A corrupt file still belongs in the list; it just shows as unparsable.
  }
  return {
    name,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    sizeBytes: Buffer.byteLength(raw, 'utf8'),
    encrypted
  }
}

// --- Folder target ---------------------------------------------------------

export class FolderTarget implements BackupTarget {
  constructor(private readonly dir: string) {}

  private requireDir(): string {
    if (!this.dir) throw new Error('No backup folder is configured.')
    return this.dir
  }

  async list(): Promise<BackupSnapshotInfo[]> {
    const dir = this.requireDir()
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      // An unreachable folder is reported by probe(); listing shouldn't throw.
      return []
    }

    const out: BackupSnapshotInfo[] = []
    for (const name of entries) {
      if (!isSnapshotName(name)) continue
      try {
        out.push(await describeSnapshot(name, await readFile(join(dir, name), 'utf8')))
      } catch {
        // Skip anything we can't read rather than failing the whole listing.
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  async write(name: string, contents: string): Promise<void> {
    const dir = this.requireDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, safeName(name)), contents, 'utf8')
  }

  async read(name: string): Promise<string> {
    return readFile(join(this.requireDir(), safeName(name)), 'utf8')
  }

  async remove(name: string): Promise<void> {
    await unlink(join(this.requireDir(), safeName(name)))
  }

  async probe(): Promise<void> {
    const dir = this.requireDir()
    await mkdir(dir, { recursive: true })
    await stat(dir)
  }
}

// --- WebDAV target ---------------------------------------------------------

export class WebdavTarget implements BackupTarget {
  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string
  ) {}

  private url(name?: string): string {
    const base = this.baseUrl.replace(/\/+$/, '')
    return name ? `${base}/${encodeURIComponent(safeName(name))}` : base
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    // WebDAV servers universally accept HTTP Basic. The password comes from
    // the OS keychain and is only ever held in memory here.
    const token = Buffer.from(`${this.username}:${this.password}`).toString('base64')
    return fetch(url, { ...init, headers: { Authorization: `Basic ${token}`, ...(init.headers ?? {}) } })
  }

  async list(): Promise<BackupSnapshotInfo[]> {
    const res = await this.request(this.url(), { method: 'PROPFIND', headers: { Depth: '1' } })
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV listing failed (HTTP ${res.status}).`)
    }

    // A minimal href scan avoids depending on the XML namespace choices, which
    // differ between server implementations.
    const body = await res.text()
    const out: BackupSnapshotInfo[] = []
    for (const match of body.matchAll(/<[^>]*href[^>]*>([^<]+)</gi)) {
      const name = safeDecode(basename(match[1].trim()))
      if (!isSnapshotName(name)) continue
      out.push(await this.describeRemote(name))
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  private async describeRemote(name: string): Promise<BackupSnapshotInfo> {
    try {
      const res = await this.request(this.url(name), { method: 'GET' })
      if (!res.ok) throw new Error(String(res.status))
      return await describeSnapshot(name, await res.text())
    } catch {
      return { name, createdAt: 0, sizeBytes: 0, encrypted: false }
    }
  }

  async write(name: string, contents: string): Promise<void> {
    const res = await this.request(this.url(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: contents
    })
    // Some servers answer PUT on an existing resource with 204, not 201.
    if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status}).`)
  }

  async read(name: string): Promise<string> {
    const res = await this.request(this.url(name), { method: 'GET' })
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`)
    return res.text()
  }

  async remove(name: string): Promise<void> {
    const res = await this.request(this.url(name), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`Delete failed (HTTP ${res.status}).`)
  }

  async probe(): Promise<void> {
    const res = await this.request(this.url(), { method: 'PROPFIND', headers: { Depth: '0' } })
    if (!res.ok && res.status !== 207) {
      throw new Error(`Could not reach the WebDAV server (HTTP ${res.status}).`)
    }
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// --- Factory ---------------------------------------------------------------

/** Builds the target described by a config, or throws if it isn't usable. */
export function createTarget(config: BackupConfig, secret: string | null): BackupTarget {
  if (config.target === 'folder') {
    if (!config.location.trim()) throw new Error('Choose a backup folder first.')
    return new FolderTarget(config.location)
  }

  if (!config.location.trim()) throw new Error('Enter your WebDAV address first.')
  let parsed: URL
  try {
    parsed = new URL(config.location)
  } catch {
    throw new Error('That does not look like a valid URL.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('WebDAV address must use http:// or https://')
  }
  return new WebdavTarget(config.location, config.username ?? '', secret ?? '')
}