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
  getPreloadPath: (scriptName: string) => Promise<string>

  storeGet: <K extends keyof StoreShape>(key: K) => Promise<StoreShape[K]>
  storeSet: <K extends keyof StoreShape>(key: K, value: StoreShape[K]) => Promise<void>

  /** Registers a menu-action listener. Returns a disposer — call it on unmount. */
  onMenuAction: (cb: (action: string) => void) => () => void
}

declare global {
  interface Window {
    api: ExposedApi
  }
}
