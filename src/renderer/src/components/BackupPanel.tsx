import { useCallback, useEffect, useState } from 'react'
import type {
  BackupConfig,
  BackupPreview,
  BackupRunResult,
  BackupSnapshotInfo,
  BackupStatus
} from '@shared/types'
import { useAppStore } from '../store/appStore'

const INTERVALS = [
  { value: 15, label: 'Every 15 minutes' },
  { value: 60, label: 'Hourly' },
  { value: 360, label: 'Every 6 hours' },
  { value: 1440, label: 'Daily' },
  { value: 0, label: 'Manual only' }
]

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatWhen(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : 'Unknown date'
}

type Notice = { tone: 'ok' | 'bad'; text: string } | null
type Preview = (BackupPreview & { name: string }) | null

/**
 * Backup settings and history.
 *
 * The two transports are presented as equal options rather than as separate
 * "providers", because from here they are the same thing: somewhere that
 * stores a file. The panel's job is to make the consequences of each choice
 * obvious - what is sent, where it lands, and what is needed to get it back.
 */
export default function BackupPanel(): JSX.Element | null {
  const open = useAppStore((s) => s.backupPanelOpen)
  const setOpen = useAppStore((s) => s.setBackupPanel)
  const reloadFromDisk = useAppStore((s) => s.reloadFromDisk)

  const [config, setConfig] = useState<BackupConfig | null>(null)
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [snapshots, setSnapshots] = useState<BackupSnapshotInfo[]>([])
  const [passphrase, setPassphrase] = useState('')
  const [keychainAvailable, setKeychainAvailable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [preview, setPreview] = useState<Preview>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // Load the config when the panel opens rather than on mount: it is a modal,
  // and the config can change while it is closed.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.all([window.api.backupGetConfig(), window.api.backupSecretPersisted()]).then(
      ([cfg, persisted]) => {
        if (cancelled) return
        setConfig(cfg)
        setKeychainAvailable(persisted)
      }
    )
    void window.api.backupList().then((s) => !cancelled && setSnapshots(s))
    return () => {
      cancelled = true
    }
  }, [open])

  // Status is pushed from the main process, so a scheduled backup shows up here
  // without the panel polling.
  useEffect(() => {
    if (!open) return
    return window.api.onBackupStatus(setStatus)
  }, [open])

  const refresh = useCallback(async () => {
    setSnapshots(await window.api.backupList())
  }, [])

  const save = useCallback(async (next: BackupConfig) => {
    setConfig(await window.api.backupSetConfig(next))
  }, [])

  const flash = useCallback((tone: 'ok' | 'bad', text: string) => setNotice({ tone, text }), [])

  const runNow = useCallback(async () => {
    if (!config) return
    // The passphrase is only held for the session, so hand it over before the
    // backup runs rather than storing it in component state and re-reading it.
    if (passphrase && config.encrypt) await window.api.backupSetSecret(passphrase)
    setBusy(true)
    const result: BackupRunResult = await window.api.backupNow()
    setBusy(false)
    flash(result.ok ? 'ok' : 'bad', result.message)
    if (result.ok) await refresh()
  }, [config, passphrase, refresh, flash])

  const onTargetChange = useCallback(
    async (target: 'folder' | 'webdav') => {
      if (!config) return
      await save({ ...config, target })
      await refresh()
    },
    [config, save, refresh]
  )

  const inspect = useCallback(
    async (snap: BackupSnapshotInfo) => {
      setSelected(snap.name)
      setPreview({ ...(await window.api.backupInspect(snap.name, passphrase || null)), name: snap.name })
    },
    [passphrase]
  )

  const restore = useCallback(
    async (merge: boolean) => {
      if (!preview?.ok) return
      const verb = merge ? 'merge this snapshot into' : 'replace everything with'
      if (!window.confirm(`About to ${verb} your current data. Continue?`)) return

      setBusy(true)
      const result = await window.api.backupRestore(preview.name, passphrase || null, merge)
      setBusy(false)

      if (result.ok) {
        flash('ok', result.message)
        setPreview(null)
        setSelected(null)
        // A restore replaces the whole store behind the renderer's back.
        reloadFromDisk()
        await refresh()
      } else {
        flash('bad', result.message)
      }
    },
    [preview, passphrase, reloadFromDisk, refresh, flash]
  )

  if (!open || !config) return null

  const isWebdav = config.target === 'webdav'
  const canRun = !!config.location.trim()

  return (
    <div className="folder-overlay backup-overlay" onClick={() => setOpen(false)}>
      <div className="folder-modal backup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="folder-header">
          <div>
            <div className="folder-title">Cloud backup</div>
            <div className="folder-sub">
              Keep an encrypted copy of your brainstorms somewhere other than this machine.
            </div>
          </div>
          <button className="btn-ghost" onClick={() => setOpen(false)} aria-label="Close backup settings">
            Close
          </button>
        </div>

        <div className="backup-body">
          <BackupDestination
            config={config}
            isWebdav={isWebdav}
            passphrase={passphrase}
            keychainAvailable={keychainAvailable}
            onDraft={setConfig}
            onCommit={save}
            onPassphrase={setPassphrase}
            onTarget={onTargetChange}
          />
          <BackupSchedule config={config} onCommit={save} />
          <BackupActions
            status={status}
            busy={busy}
            canRun={canRun}
            onRun={runNow}
            onTest={async () => {
              await save(config)
              const r = await window.api.backupTestConnection()
              flash(r.ok ? 'ok' : 'bad', r.message)
            }}
          />
          <BackupHistory
            snapshots={snapshots}
            selected={selected}
            preview={preview}
            busy={busy}
            canRun={canRun}
            onInspect={inspect}
            onRefresh={refresh}
            onRestore={restore}
          />
        </div>

        {notice && (
          <div className={`backup-toast ${notice.tone}`} role="status">
            {notice.text}
          </div>
        )}
      </div>
    </div>
  )
}

interface DestinationProps {
  config: BackupConfig
  isWebdav: boolean
  passphrase: string
  keychainAvailable: boolean
  onDraft: (c: BackupConfig) => void
  onCommit: (c: BackupConfig) => Promise<void>
  onPassphrase: (v: string) => void
  onTarget: (t: 'folder' | 'webdav') => Promise<void>
}

/** Destination choice plus the credentials that choice implies. */
function BackupDestination({
  config,
  isWebdav,
  passphrase,
  keychainAvailable,
  onDraft,
  onCommit,
  onPassphrase,
  onTarget
}: DestinationProps): JSX.Element {
  return (
    <section className="backup-section">
      <h3 className="backup-heading">Where to</h3>
      <div className="backup-targets" role="radiogroup" aria-label="Backup destination">
        <button
          className={`backup-target${!isWebdav ? ' active' : ''}`}
          onClick={() => void onTarget('folder')}
          role="radio"
          aria-checked={!isWebdav}
        >
          <strong>Synced folder</strong>
          <span>Dropbox, OneDrive, Google Drive, or any local folder.</span>
        </button>
        <button
          className={`backup-target${isWebdav ? ' active' : ''}`}
          onClick={() => void onTarget('webdav')}
          role="radio"
          aria-checked={isWebdav}
        >
          <strong>WebDAV server</strong>
          <span>Nextcloud, ownCloud, or a NAS over http(s).</span>
        </button>
      </div>

      <label className="backup-field">
        <span>{isWebdav ? 'Server address' : 'Folder'}</span>
        <input
          type="text"
          value={config.location}
          spellCheck={false}
          placeholder={
            isWebdav
              ? 'https://cloud.example.com/remote.php/dav/files/me'
              : 'C:\\Users\\you\\Dropbox\\Brainstorm'
          }
          onChange={(e) => onDraft({ ...config, location: e.target.value })}
          onBlur={() => void onCommit(config)}
        />
      </label>

      {isWebdav && (
        <label className="backup-field">
          <span>Username</span>
          <input
            type="text"
            value={config.username ?? ''}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onDraft({ ...config, username: e.target.value })}
            onBlur={() => void onCommit(config)}
          />
        </label>
      )}

      <label className="backup-field">
        <span>{isWebdav ? 'Server password' : 'Encryption passphrase'}</span>
        <input
          type="password"
          value={passphrase}
          spellCheck={false}
          autoComplete="off"
          placeholder={config.encrypt ? 'Needed to read an encrypted snapshot back' : 'Not used'}
          onChange={(e) => onPassphrase(e.target.value)}
        />
      </label>

      {!keychainAvailable && (
        <p className="backup-warn">
          This system has no usable keychain, so the {isWebdav ? 'password' : 'passphrase'} is kept for
          this session only. Scheduled backups may need it re-entering.
        </p>
      )}
    </section>
  )
}

interface ScheduleProps {
  config: BackupConfig
  onCommit: (c: BackupConfig) => Promise<void>
}

/** When backups run, how many are kept, and whether they are encrypted. */
function BackupSchedule({ config, onCommit }: ScheduleProps): JSX.Element {
  return (
    <section className="backup-section">
      <h3 className="backup-heading">Automatic</h3>

      <label className="backup-toggle">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => void onCommit({ ...config, enabled: e.target.checked })}
        />
        <span>Back up automatically</span>
      </label>

      <div className="backup-row">
        <label className="backup-field">
          <span>How often</span>
          <select
            value={config.intervalMinutes}
            onChange={(e) => void onCommit({ ...config, intervalMinutes: Number(e.target.value) })}
            disabled={!config.enabled}
          >
            {INTERVALS.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
        <label className="backup-field">
          <span>Snapshots to keep</span>
          <input
            type="number"
            min={1}
            max={500}
            value={config.keepSnapshots}
            onChange={(e) => void onCommit({ ...config, keepSnapshots: Number(e.target.value) })}
          />
        </label>
      </div>

      <label className="backup-toggle">
        <input
          type="checkbox"
          checked={config.encrypt}
          onChange={(e) => void onCommit({ ...config, encrypt: e.target.checked })}
        />
        <span>Encrypt snapshots (AES-256-GCM)</span>
      </label>
      <p className="backup-hint">
        A snapshot with no passphrase cannot be read back. If the passphrase is lost, so is the data.
      </p>
    </section>
  )
}

interface ActionsProps {
  status: BackupStatus | null
  busy: boolean
  canRun: boolean
  onRun: () => Promise<void>
  onTest: () => Promise<void>
}

/** Run now, check the destination is reachable, and show the last outcome. */
function BackupActions({ status, busy, canRun, onRun, onTest }: ActionsProps): JSX.Element {
  return (
    <section className="backup-section">
      <div className="backup-actions">
        <button className="btn-primary" onClick={() => void onRun()} disabled={!canRun || busy}>
          {busy ? 'Working…' : 'Back up now'}
        </button>
        <button className="btn-secondary" onClick={() => void onTest()} disabled={!canRun || busy}>
          Test connection
        </button>
      </div>
      <p className="backup-status">
        {status?.running
          ? 'Backup in progress…'
          : status?.lastError
            ? `Last attempt failed: ${status.lastError}`
            : status?.lastRunAt
              ? `Last backup ${formatWhen(status.lastRunAt)}.`
              : 'No backup taken yet.'}
      </p>
    </section>
  )
}

interface HistoryProps {
  snapshots: BackupSnapshotInfo[]
  selected: string | null
  preview: Preview
  busy: boolean
  canRun: boolean
  onInspect: (s: BackupSnapshotInfo) => Promise<void>
  onRefresh: () => Promise<void>
  onRestore: (merge: boolean) => Promise<void>
}

/**
 * The snapshot list, with restore gated behind an explicit choice between
 * merging and replacing. Both are offered because the right one depends on
 * whether the snapshot came from this machine or another, and guessing wrong
 * loses work either way.
 */
function BackupHistory({
  snapshots,
  selected,
  preview,
  busy,
  canRun,
  onInspect,
  onRefresh,
  onRestore
}: HistoryProps): JSX.Element {
  return (
    <section className="backup-section">
      <div className="backup-heading-row">
        <h3 className="backup-heading">Snapshots</h3>
        <button className="btn-ghost btn-sm" onClick={() => void onRefresh()}>
          Refresh
        </button>
      </div>

      {snapshots.length === 0 ? (
        <p className="backup-hint">
          {canRun
            ? 'No snapshots yet — take one to get started.'
            : 'Set a destination above to see snapshots here.'}
        </p>
      ) : (
        <ul className="backup-list">
          {snapshots.map((snap) => (
            <li key={snap.name} className={`backup-item${selected === snap.name ? ' active' : ''}`}>
              <button className="backup-item-main" onClick={() => void onInspect(snap)}>
                <span className="backup-item-when">{formatWhen(snap.createdAt)}</span>
                <span className="backup-item-meta">
                  {formatBytes(snap.sizeBytes)} · {snap.encrypted ? 'encrypted' : 'not encrypted'}
                </span>
              </button>

              {selected === snap.name && preview && (
                <div className="backup-preview">
                  {preview.ok ? (
                    <>
                      <p>
                        {preview.brainstorms} brainstorm{preview.brainstorms === 1 ? '' : 's'} ·{' '}
                        {preview.ideas} ideas · {preview.messages} messages
                      </p>
                      <div className="backup-actions">
                        <button
                          className="btn-secondary"
                          onClick={() => void onRestore(true)}
                          disabled={busy}
                        >
                          Merge with current
                        </button>
                        <button className="btn-danger" onClick={() => void onRestore(false)} disabled={busy}>
                          Replace everything
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="backup-bad">{preview.message}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}


