// Shared types used by both the main and renderer processes.

// Brainstorm prompt intents. These drive the templates in lib/prompt.ts and the
// buttons in the AI panel.
export type AIAction = 'brainstorm' | 'expand' | 'critique' | 'ask'

export type SessionSort = 'recent' | 'alpha' | 'created'

export type AccentName = 'azure' | 'violet' | 'emerald' | 'amber' | 'rose'

export interface AppSettings {
  theme: 'dark' | 'light'
  /** Editor font size in px, applied to the notes surface. */
  fontSize: number
  aiPanelWidth: number
  sidebarWidth: number
  sessionSort?: SessionSort
  /** UI accent hue, applied as a CSS custom property on the app root. */
  accent?: AccentName
  /** Hide sidebar + AI panel for a distraction-free writing surface. */
  focusMode?: boolean
  /** Coalesce rapid writes. Rarely worth disabling; kept for testing. */
  autosave?: boolean
}

export const ACCENTS: AccentName[] = ['azure', 'violet', 'emerald', 'amber', 'rose']

// A captured idea — either something the user wrote or a response pulled out of
// the ChatGPT panel.
export interface Idea {
  id: string
  text: string
  source: 'me' | 'ai'
  createdAt: number
}

// One turn of the AI conversation, captured from the panel so it survives after
// the ephemeral ChatGPT chat is gone.
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  bookmarked?: boolean
}

export interface InlineSuggestion {
  id: string
  sessionId: string
  originalText: string
  suggestedText: string
  timestamp: number
}

export interface ConsolidationState {
  sessionId: string
  active: boolean
  chunks: string[]
  currentChunkIndex: number
  totalChunks: number
}

// A work folder (Workspace). Brainstorms are grouped inside folders instead of
// living in one global flat list.
export interface WorkFolder {
  id: string
  name: string
  createdAt: number
}

// A brainstorming session: a free-form notes/outline buffer plus a list of
// captured ideas. Belongs to exactly one work folder.
export interface BrainstormSession {
  id: string
  folderId: string
  title: string
  notes: string
  ideas: Idea[]
  messages: ChatMessage[]
  /** The ChatGPT /c/<id> conversation URL, captured so the session can be
   *  reopened and continued. Absent for guest-mode chats (no stable URL). */
  chatUrl?: string
  starred?: boolean
  createdAt: number
  updatedAt: number
}

export interface StoreShape {
  folders: WorkFolder[]
  sessions: BrainstormSession[]
  settings: AppSettings
}

// --- Cloud backup ------------------------------------------------------------
//
// Backups are provider-agnostic. A "target" is anywhere a snapshot can be
// written and read back: a folder that some other program syncs (Dropbox,
// OneDrive, Google Drive) or a WebDAV endpoint (Nextcloud, ownCloud, a NAS).
// Keeping it to these two means no vendor SDK, API key, or OAuth dance, and
// they cover the setups people already have.

export type BackupTargetKind = 'folder' | 'webdav'

export interface BackupConfig {
  enabled: boolean
  target: BackupTargetKind
  /** Absolute path (folder target) or base URL (webdav target). */
  location: string
  /** WebDAV only. Never written to the settings file — see safeStorage. */
  username?: string
  /** Minutes between automatic backups. 0 disables the timer. */
  intervalMinutes: number
  /** How many snapshots to keep at the target before pruning the oldest. */
  keepSnapshots: number
  /** Encrypt snapshot contents with a passphrase. */
  encrypt: boolean
}

export interface BackupSnapshotInfo {
  /** Snapshot name as stored, e.g. "2024-06-01T10-22-05Z.brainstorm". */
  name: string
  createdAt: number
  sizeBytes: number
  encrypted: boolean
}

export interface BackupStatus {
  /** Whether the target is configured well enough to attempt a backup. */
  configured: boolean
  running: boolean
  lastRunAt: number | null
  lastError: string | null
  lastSnapshot: string | null
  /** True when the OS keychain is available, so the passphrase can be kept. */
  passphrasePersisted: boolean
}

export interface BackupRunResult {
  ok: boolean
  message: string
  /** Set on a successful write. */
  snapshot?: BackupSnapshotInfo
  /** Count of snapshots removed by retention pruning. */
  pruned?: number
}

// What a snapshot holds, shown before the user commits to a restore.
export interface BackupPreview {
  ok: boolean
  message: string
  createdAt?: number
  appVersion?: string
  encrypted?: boolean
  workspaces?: number
  brainstorms?: number
  ideas?: number
  messages?: number
}

// The on-disk envelope. Contents are the StoreShape payload; everything else
// is metadata that stays readable so a snapshot can be listed and dated
// without a passphrase, and so a future version can migrate an old one.
export interface BackupEnvelope {
  format: 'brainstorm-backup'
  version: 1
  createdAt: number
  appVersion: string
  /** Present only when the payload is encrypted. */
  encryption?: {
    algorithm: 'aes-256-gcm'
    kdf: 'scrypt'
    salt: string
    iv: string
    authTag: string
    N: number
    r: number
    p: number
  }
  /** JSON-encoded StoreShape. Absent when encrypted. */
  data?: StoreShape
  /** Base64 ciphertext of the JSON-encoded StoreShape. Present when encrypted. */
  cipherText?: string
}


// --- ChatGPT webview bridge -------------------------------------------------

export interface OutboundOpConfig {
  action: 'fillInput' | 'clickElement' | 'fillAndSubmit'
  selector: string
  valueProperty?: 'value' | 'textContent' | 'innerText'
  eventType?: string
  delayMs?: number
}

export interface InboundConfig {
  observeSelector: string
  messageSelector: string
  codeBlockSelector: string
  languageClassPattern?: string
}

export interface DomBridgeConfig {
  outbound: Record<string, OutboundOpConfig>
  inbound: InboundConfig
}

export interface CodeBlock {
  language: string
  code: string
}

export interface InboundPayload {
  text: string
  codeBlocks: CodeBlock[]
  timestamp: number
}

// A response scraped out of the ChatGPT panel is recorded straight into the
// session transcript (ChatMessage), so no separate pending-response queue is
// needed on the host side.

export interface DomBridgeErrorPayload {
  channel?: string
  message: string
}

// The surface exposed to the renderer via contextBridge (see preload/index.ts).
export interface ExposedApi {
  copyToClipboard: (text: string) => Promise<void>
  /** Opens a native save dialog and writes `content`. Resolves true if saved. */
  exportFile: (defaultName: string, content: string) => Promise<boolean>
  /** Opens a native open dialog and reads a file. Resolves null if cancelled. */
  readFile: (extensions?: string[]) => Promise<BackupEnvelope | null>
  getPreloadPath: (scriptName: string) => Promise<string>

  storeGet: <K extends keyof StoreShape>(key: K) => Promise<StoreShape[K]>
  storeSet: <K extends keyof StoreShape>(key: K, value: StoreShape[K]) => Promise<void>

  // --- backup ---
  backupGetConfig: () => Promise<BackupConfig>
  backupSetConfig: (config: BackupConfig) => Promise<BackupConfig>
  /** Stores the WebDAV password in the OS keychain. Pass null to forget it. */
  backupSetSecret: (password: string | null) => Promise<boolean>
  /** True when the OS keychain is usable on this machine. */
  backupSecretPersisted: () => Promise<boolean>
  backupNow: () => Promise<BackupRunResult>
  backupList: () => Promise<BackupSnapshotInfo[]>
  backupInspect: (name: string, passphrase?: string) => Promise<BackupPreview>
  /** Replaces local data. Pass keepLocal=true to merge instead of overwrite. */
  backupRestore: (name: string, passphrase: string | null, keepLocal: boolean) => Promise<BackupRunResult>
  backupTestConnection: () => Promise<{ ok: boolean; message: string }>
  /** Fires whenever a backup finishes or the status changes. */
  onBackupStatus: (cb: (status: BackupStatus) => void) => () => void

  /** Registers a menu-action listener. Returns a disposer — call it on unmount. */
  onMenuAction: (cb: (action: string) => void) => () => void
}

declare global {
  interface Window {
    api: ExposedApi
  }
}
