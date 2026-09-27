import { create } from 'zustand'
import { ACCENTS } from '@shared/types'
import type {
  AppSettings,
  BrainstormSession,
  ChatMessage,
  Idea,
  WorkFolder
} from '@shared/types'

// A pending request to recover a session's conversation. ChatView builds the
// chunks; AIPanel (which owns the webview bridge) picks up the request and runs
// the injection. The nonce lets AIPanel react to repeated requests.
export interface RecoveryRequest {
  sessionId: string
  chunks: string[]
  nonce: number
}

// Live progress of an in-flight recovery, for the progress bar.
export interface RecoveryProgress {
  sessionId: string
  total: number
  sent: number
}

// A request to send a prompt to a specific session's AI panel, raised by the
// notes context menu (Critique/Expand) and consumed by that session's webview.
export interface AiActionRequest {
  sessionId: string
  prompt: string
  originalText?: string
  nonce: number
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function makeSession(folderId: string, title: string): BrainstormSession {
  const now = Date.now()
  return {
    id: newId('sess'),
    folderId,
    title: title || 'Untitled brainstorm',
    notes: '',
    ideas: [],
    messages: [],
    createdAt: now,
    updatedAt: now
  }
}

// Older persisted sessions may predate a field. Fill in defaults on load so the
// rest of the app can treat every session as fully shaped. A missing folderId
// becomes '' so the load migration can adopt it into a default folder.
function normalizeSession(s: BrainstormSession): BrainstormSession {
  return { ...s, folderId: s.folderId ?? '', ideas: s.ideas ?? [], messages: s.messages ?? [] }
}

interface AppState {
  folders: WorkFolder[]
  activeFolderId: string | null
  folderModalOpen: boolean
  sessions: BrainstormSession[]
  activeSessionId: string | null
  settings: AppSettings
  aiPanelVisible: boolean
  commandPaletteOpen: boolean
  /** True once the on-disk store has been read into memory. */
  hydrated: boolean

  // --- work folders (workspaces) ---
  setFolders: (folders: WorkFolder[]) => void
  createFolder: (name: string) => string
  renameFolder: (id: string, name: string) => void
  deleteFolder: (id: string) => void
  openFolder: (id: string) => void
  setFolderModal: (open: boolean) => void

  // Conversation recovery (context re-injection).
  recoveryRequest: RecoveryRequest | null
  recovery: RecoveryProgress | null
  requestRecovery: (sessionId: string, chunks: string[]) => void
  clearRecoveryRequest: () => void
  setRecovery: (recovery: RecoveryProgress | null) => void

  // AI action requests from the notes context menu.
  aiActionRequest: AiActionRequest | null
  requestAiAction: (sessionId: string, prompt: string, originalText?: string) => void
  clearAiActionRequest: () => void

  // Inline AI suggestions for NotesEditor
  inlineSuggestion: import('@shared/types').InlineSuggestion | null
  setInlineSuggestion: (suggestion: import('@shared/types').InlineSuggestion | null) => void
  clearInlineSuggestion: () => void

  // Consolidation State
  consolidationState: import('@shared/types').ConsolidationState | null
  startConsolidation: (sessionId: string) => void
  advanceConsolidation: () => void
  cancelConsolidation: () => void

  // --- session lifecycle ---
  setSessions: (sessions: BrainstormSession[]) => void
  newSession: (title?: string) => void
  selectSession: (id: string) => void
  deleteSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  toggleStarSession: (id: string) => void
  setNotes: (id: string, notes: string) => void
  addIdea: (id: string, idea: Omit<Idea, 'id' | 'createdAt'>) => void
  removeIdea: (sessionId: string, ideaId: string) => void
  addMessage: (id: string, message: ChatMessage) => void
  toggleBookmarkMessage: (sessionId: string, messageIndex: number) => void
  clearMessages: (id: string) => void
  setChatUrl: (id: string, chatUrl: string) => void

  // --- ui ---
  setSettings: (s: Partial<AppSettings>) => void
  toggleAiPanel: () => void
  setCommandPalette: (open: boolean) => void
  toggleFocusMode: () => void
  cycleAccent: () => void

  // --- session actions ---
  duplicateSession: (id: string) => void
  promoteIdeaToNotes: (sessionId: string, ideaId: string) => void
}

// --- Derived selectors -------------------------------------------------------
// Components subscribe through these instead of picking whole slices off the
// store. A raw `useAppStore(s => s.sessions)` re-renders the component on every
// keystroke anywhere in the app; a selector that returns a stable reference for
// unchanged data does not.

export function findSession(sessions: BrainstormSession[], id: string | null): BrainstormSession | null {
  if (!id) return null
  return sessions.find((s) => s.id === id) ?? null
}

export const selectActiveFolder = (s: AppState): WorkFolder | null =>
  findFolder(s.folders, s.activeFolderId)

function findFolder(folders: WorkFolder[], id: string | null): WorkFolder | null {
  if (!id) return null
  return folders.find((f) => f.id === id) ?? null
}

// Total counts for the status bar, so it never re-renders on a body-text edit.
export const selectTotals = (s: AppState): { sessions: number; ideas: number } => ({
  sessions: s.sessions.length,
  ideas: s.sessions.reduce((n, x) => n + x.ideas.length, 0)
})

// --- Mutators ----------------------------------------------------------------

// Mutates the matching session and bumps updatedAt.
function touchSession(
  sessions: BrainstormSession[],
  id: string,
  fn: (s: BrainstormSession) => BrainstormSession
): BrainstormSession[] {
  return sessions.map((s) => (s.id === id ? { ...fn(s), updatedAt: Date.now() } : s))
}

export const useAppStore = create<AppState>((set, get) => ({
  folders: [],
  activeFolderId: null,
  // Mandatory first view: the folder selector is open until a folder is chosen.
  folderModalOpen: true,
  sessions: [],
  activeSessionId: null,
  settings: {
    theme: 'dark',
    fontSize: 14,
    aiPanelWidth: 420,
    sidebarWidth: 260,
    sessionSort: 'recent',
    accent: 'azure',
    focusMode: false,
    autosave: true
  },
  aiPanelVisible: true,
  commandPaletteOpen: false,
  hydrated: false,
  recoveryRequest: null,
  recovery: null,
  aiActionRequest: null,

  setFolders: (folders) => set({ folders }),

  createFolder: (name) => {
    const folder: WorkFolder = { id: newId('folder'), name: name.trim() || 'New folder', createdAt: Date.now() }
    set((state) => ({ folders: [...state.folders, folder] }))
    return folder.id
  },

  renameFolder: (id, name) =>
    set((state) => ({
      folders: state.folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f))
    })),

  deleteFolder: (id) =>
    set((state) => {
      const folders = state.folders.filter((f) => f.id !== id)
      // Remove the folder's brainstorms with it.
      const sessions = state.sessions.filter((s) => s.folderId !== id)
      const wasActive = state.activeFolderId === id
      return {
        folders,
        sessions,
        activeFolderId: wasActive ? null : state.activeFolderId,
        activeSessionId: wasActive ? null : state.activeSessionId,
        // Deleting the open folder drops the user back to the selector.
        folderModalOpen: wasActive ? true : state.folderModalOpen
      }
    }),

  // Load a folder: close the modal and scope the main view to it.
  openFolder: (id) =>
    set((state) => {
      const first = state.sessions.find((s) => s.folderId === id) ?? null
      return { activeFolderId: id, folderModalOpen: false, activeSessionId: first?.id ?? null }
    }),

  setFolderModal: (open) => set({ folderModalOpen: open }),

  setSessions: (sessions) => set({ sessions: sessions.map(normalizeSession) }),

  newSession: (title) =>
    set((state) => {
      if (!state.activeFolderId) return state
      const session = makeSession(state.activeFolderId, title ?? '')
      return { sessions: [session, ...state.sessions], activeSessionId: session.id }
    }),

  selectSession: (id) => set({ activeSessionId: id }),

  deleteSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id)
      let activeSessionId = state.activeSessionId
      if (activeSessionId === id) {
        // Fall back to another session in the same folder, not a global one.
        activeSessionId = sessions.find((s) => s.folderId === state.activeFolderId)?.id ?? null
      }
      return { sessions, activeSessionId }
    }),

  renameSession: (id, title) =>
    set((state) => ({ sessions: touchSession(state.sessions, id, (s) => ({ ...s, title })) })),

  // Star/pin toggle. Does NOT bump updatedAt — pinning is organisational, not
  // an edit, so it shouldn't reorder a "recent"-sorted list.
  toggleStarSession: (id) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, starred: !s.starred } : s))
    })),

  setNotes: (id, notes) =>
    set((state) => ({ sessions: touchSession(state.sessions, id, (s) => ({ ...s, notes })) })),

  addIdea: (id, idea) =>
    set((state) => ({
      sessions: touchSession(state.sessions, id, (s) => ({
        ...s,
        ideas: [...s.ideas, { ...idea, id: newId('idea'), createdAt: Date.now() }]
      }))
    })),

  removeIdea: (sessionId, ideaId) =>
    set((state) => ({
      sessions: touchSession(state.sessions, sessionId, (s) => ({
        ...s,
        ideas: s.ideas.filter((i) => i.id !== ideaId)
      }))
    })),

  // Moves a captured idea into the notes body and retires the card — the common
  // next step once an idea is worth keeping.
  promoteIdeaToNotes: (sessionId, ideaId) =>
    set((state) => ({
      sessions: touchSession(state.sessions, sessionId, (s) => {
        const idea = s.ideas.find((i) => i.id === ideaId)
        if (!idea) return s
        const block = `- ${idea.text.trim()}`
        const notes = s.notes.trim() ? `${s.notes.replace(/\s+$/, '')}\n\n${block}` : block
        return { ...s, notes, ideas: s.ideas.filter((i) => i.id !== ideaId) }
      })
    })),


  // Copies a brainstorm (notes, ideas, and the conversation link) into a new
  // session. The transcript is intentionally not carried over — the copy is a
  // fresh line of thinking seeded from the original.
  duplicateSession: (id) =>
    set((state) => {
      const source = state.sessions.find((s) => s.id === id)
      if (!source) return state
      const now = Date.now()
      const copy: BrainstormSession = {
        ...source,
        id: newId('sess'),
        title: `${source.title || 'Untitled brainstorm'} (copy)`,
        createdAt: now,
        updatedAt: now,
        starred: false,
        notes: source.notes,
        ideas: source.ideas.map((i) => ({ ...i, id: newId('idea'), createdAt: now })),
        messages: []
      }
      const at = state.sessions.findIndex((s) => s.id === id)
      const sessions = [...state.sessions]
      sessions.splice(at + 1, 0, copy)
      return { sessions, activeSessionId: copy.id }
    }),


  addMessage: (id, message) =>
    set((state) => ({
      sessions: touchSession(state.sessions, id, (s) => ({
        ...s,
        messages: [...s.messages, message]
      }))
    })),

  toggleBookmarkMessage: (sessionId, messageIndex) =>
    set((state) => ({
      sessions: touchSession(state.sessions, sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m, idx) =>
          idx === messageIndex ? { ...m, bookmarked: !m.bookmarked } : m
        )
      }))
    })),

  clearMessages: (id) =>
    set((state) => ({ sessions: touchSession(state.sessions, id, (s) => ({ ...s, messages: [] })) })),

  // Records the conversation URL. Does NOT bump updatedAt — a URL capture is
  // bookkeeping, not user activity, and shouldn't reorder the session list.
  setChatUrl: (id, chatUrl) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, chatUrl } : s))
    })),

  setSettings: (s) => set((state) => ({ settings: { ...state.settings, ...s } })),
  toggleAiPanel: () => set((state) => ({ aiPanelVisible: !state.aiPanelVisible })),
  setCommandPalette: (open) => set({ commandPaletteOpen: open }),

  // Focus mode collapses the sidebar and the AI panel, leaving only the notes —
  // the equivalent of a full-screen editor for a stretch of uninterrupted work.
  toggleFocusMode: () =>
    set((state) => ({ settings: { ...state.settings, focusMode: !state.settings.focusMode } })),

  cycleAccent: () =>
    set((state) => {
      const order = ACCENTS
      const next = order[(order.indexOf(state.settings.accent ?? 'azure') + 1) % order.length]
      return { settings: { ...state.settings, accent: next } }
    }),

  requestRecovery: (sessionId, chunks) =>
    set({ recoveryRequest: { sessionId, chunks, nonce: Date.now() } }),
  clearRecoveryRequest: () => set({ recoveryRequest: null }),
  setRecovery: (recovery) => set({ recovery }),

  requestAiAction: (sessionId, prompt, originalText) =>
    set({ aiActionRequest: { sessionId, prompt, originalText, nonce: Date.now() } }),
  clearAiActionRequest: () => set({ aiActionRequest: null }),

  inlineSuggestion: null,
  setInlineSuggestion: (suggestion) => set({ inlineSuggestion: suggestion }),
  clearInlineSuggestion: () => set({ inlineSuggestion: null }),

  consolidationState: null,
  startConsolidation: (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session || !session.notes.trim()) return

    const notes = session.notes.trim()
    const words = notes.split(/\s+/).filter(Boolean)

    if (words.length < 5000) {
      const prompt = `I want to consolidate my notes. Here is the raw text. Please reformat it professionally without losing any information: \n\n${notes}`
      set({
        consolidationState: {
          sessionId,
          active: true,
          chunks: [prompt],
          currentChunkIndex: 0,
          totalChunks: 1
        }
      })
      get().requestAiAction(sessionId, prompt)
    } else {
      // Split into ~4500 word chunks
      const paragraphs = notes.split(/\n\n+/)
      const rawChunks: string[] = []
      let current = ''
      let currentWordCount = 0

      for (const p of paragraphs) {
        const count = p.split(/\s+/).filter(Boolean).length
        if (currentWordCount + count > 4500 && current.trim()) {
          rawChunks.push(current.trim())
          current = p
          currentWordCount = count
        } else {
          current = current ? `${current}\n\n${p}` : p
          currentWordCount += count
        }
      }
      if (current.trim()) {
        rawChunks.push(current.trim())
      }

      const total = rawChunks.length
      const prompts = rawChunks.map((chunk, idx) => {
        const partNum = idx + 1
        if (partNum < total) {
          return `I'm going to give you my notes in chunks so we can consolidate them. This is part ${partNum} of ${total}. Just read it and reply 'waiting'. \n\n${chunk}`
        } else {
          return `Here is the final part ${partNum} of ${total}. That's the last of it. Now, take all the parts I just sent and reformat the entire text into a clean, professional document. Do not lose any information. \n\n${chunk}`
        }
      })

      set({
        consolidationState: {
          sessionId,
          active: true,
          chunks: prompts,
          currentChunkIndex: 0,
          totalChunks: total
        }
      })
      get().requestAiAction(sessionId, prompts[0])
    }
  },

  advanceConsolidation: () => {
    const cs = get().consolidationState
    if (!cs || !cs.active) return
    const nextIdx = cs.currentChunkIndex + 1
    if (nextIdx < cs.totalChunks) {
      const nextPrompt = cs.chunks[nextIdx]
      set({
        consolidationState: {
          ...cs,
          currentChunkIndex: nextIdx
        }
      })
      get().requestAiAction(cs.sessionId, nextPrompt)
    }
  },

  cancelConsolidation: () => set({ consolidationState: null })
}))
