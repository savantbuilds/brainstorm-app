import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccentName } from '@shared/types'
import AIPanel from './components/AIPanel'
import CenterPane from './components/CenterPane'
import CommandPalette, { type Command } from './components/CommandPalette'
import SessionList from './components/SessionList'
import StatusBar from './components/StatusBar'
import TopBar from './components/TopBar'
import WorkFolderModal from './components/WorkFolderModal'
import { useAppStore } from './store/appStore'
import { usePersistence } from './store/persistence'

export default function App(): JSX.Element {
  const theme = useAppStore((s) => s.settings.theme)
  const accent = useAppStore((s) => s.settings.accent ?? 'azure')
  const focusMode = useAppStore((s) => s.settings.focusMode ?? false)
  const aiPanelVisible = useAppStore((s) => s.aiPanelVisible)

  const [aiWidth, setAiWidth] = useState(() => useAppStore.getState().settings.aiPanelWidth)
  const [sidebarWidth, setSidebarWidth] = useState(() => useAppStore.getState().settings.sidebarWidth)
  const [dragging, setDragging] = useState<null | 'ai' | 'sidebar'>(null)

  // Load from disk, then keep writing back on a debounce.
  usePersistence()

  // Latest widths for the drag-end persist (the drag effect only depends on
  // `dragging`, so its mouseup closure would otherwise capture stale widths).
  const aiWidthRef = useRef(aiWidth)
  aiWidthRef.current = aiWidth
  const sidebarWidthRef = useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth

  // Adopt the persisted pane widths once the store has been hydrated.
  const hydrated = useAppStore((s) => s.hydrated)
  useEffect(() => {
    if (!hydrated) return
    const { aiPanelWidth, sidebarWidth: sw } = useAppStore.getState().settings
    setAiWidth(aiPanelWidth)
    setSidebarWidth(sw)
  }, [hydrated])

  const sessions = useAppStore((s) => s.sessions)
  const activeFolderId = useAppStore((s) => s.activeFolderId)

  const newSession = useCallback(() => useAppStore.getState().newSession(), [])
  const toggleAi = useCallback(() => useAppStore.getState().toggleAiPanel(), [])

  // Rebuilt only when something it actually reads changes. Every entry closes
  // over the store's getState(), so none of them capture stale state.
  const commands = useMemo<Command[]>(() => {
    const st = () => useAppStore.getState()
    const list: Command[] = [
      { id: 'new-session', label: 'Brainstorm: New', hint: 'Ctrl+N', run: newSession },
      {
        id: 'duplicate',
        label: 'Brainstorm: Duplicate current',
        run: () => {
          const id = st().activeSessionId
          if (id) st().duplicateSession(id)
        }
      },
      {
        id: 'delete',
        label: 'Brainstorm: Delete current',
        run: () => {
          const id = st().activeSessionId
          const s = st().sessions.find((x) => x.id === id)
          if (id && s && window.confirm(`Delete "${s.title || 'Untitled brainstorm'}"?`)) {
            st().deleteSession(id)
          }
        }
      },
      { id: 'toggle-ai', label: 'View: Toggle AI panel', hint: 'Ctrl+Shift+A', run: toggleAi },
      { id: 'focus-mode', label: 'View: Toggle focus mode', hint: 'Ctrl+Shift+F', run: () => st().toggleFocusMode() },
      {
        id: 'toggle-theme',
        label: 'View: Toggle light / dark theme',
        run: () => st().setSettings({ theme: st().settings.theme === 'dark' ? 'light' : 'dark' })
      },
      { id: 'cycle-accent', label: 'View: Cycle accent colour', run: () => st().cycleAccent() },
      { id: 'open-workspaces', label: 'Workspace: Open folder selector', run: () => st().setFolderModal(true) },
      {
        id: 'consolidate',
        label: 'Notes: Consolidate with AI',
        run: () => {
          const id = st().activeSessionId
          if (id) st().startConsolidation(id)
        }
      },
      {
        id: 'export',
        label: 'Notes: Export as Markdown',
        hint: 'Ctrl+E',
        run: () => window.dispatchEvent(new CustomEvent('brainstorm:export'))
      }
    ]
    for (const s of sessions) {
      list.push({
        id: `goto-${s.id}`,
        label: `Go to: ${s.title || 'Untitled brainstorm'}`,
        hint: `${s.ideas.length} idea${s.ideas.length === 1 ? '' : 's'}`,
        group: 'Brainstorms',
        run: () => useAppStore.getState().selectSession(s.id)
      })
    }
    return list
  }, [sessions, newSession, toggleAi])

  // Native menu actions from the main process.
  useEffect(() => {
    const dispose = window.api.onMenuAction((action) => {
      const st = useAppStore.getState()
      switch (action) {
        case 'new-session':
          newSession()
          break
        case 'toggle-ai':
          toggleAi()
          break
        case 'toggle-theme':
          st.setSettings({ theme: st.settings.theme === 'dark' ? 'light' : 'dark' })
          break
        case 'focus-mode':
          st.toggleFocusMode()
          break
        case 'command-palette':
          st.setCommandPalette(true)
          break
        default:
          break
      }
    })
    return dispose
  }, [newSession, toggleAi])

  // Global keyboard shortcuts. Anything typed into a field is left alone except
  // for the chords, so the editor never swallows a plain keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const st = useAppStore.getState()
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const target = e.target as HTMLElement | null
      const typing = !!target && (/^(INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)

      if (mod && e.shiftKey && key === 'p') {
        e.preventDefault()
        st.setCommandPalette(true)
      } else if (mod && e.shiftKey && key === 'a') {
        e.preventDefault()
        st.toggleAiPanel()
      } else if (mod && e.shiftKey && key === 'f') {
        e.preventDefault()
        st.toggleFocusMode()
      } else if (mod && !e.shiftKey && key === 'n' && !typing) {
        e.preventDefault()
        st.newSession()
      } else if (mod && !e.shiftKey && key === 'e' && !typing) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('brainstorm:export'))
      } else if (e.key === 'Escape' && st.commandPaletteOpen) {
        st.setCommandPalette(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Pane resizing. A single listener pair is attached to window while a handle
  // is active, and a full-window overlay (rendered below) sits above the
  // <webview> so mousemove/mouseup keep firing even when the cursor is dragged
  // over the embedded ChatGPT page — the previous version lost the drag there.
  const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max)

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent): void => {
      if (dragging === 'ai') {
        setAiWidth(clamp(window.innerWidth - e.clientX, 280, 900))
      } else {
        setSidebarWidth(clamp(e.clientX, 160, 560))
      }
    }
    const onUp = (): void => {
      setDragging(null)
      // One write: setSettings alone is enough, since persistence is debounced
      // and picks the change up off the store subscription.
      useAppStore.getState().setSettings({
        aiPanelWidth: aiWidthRef.current,
        sidebarWidth: sidebarWidthRef.current
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  // Focus mode takes over the whole window, so anything modal must stand down.
  useEffect(() => {
    if (focusMode) useAppStore.getState().setCommandPalette(false)
  }, [focusMode])

  const showAi = aiPanelVisible && !focusMode

  return (
    <div
      className={`app theme-${theme}${dragging ? ' dragging' : ''}${focusMode ? ' focus-mode' : ''}`}
      data-accent={accent as AccentName}
    >
      <TopBar />
      <div className="main-row">
        <SessionList width={sidebarWidth} />
        <div
          className="resize-handle"
          onMouseDown={() => setDragging('sidebar')}
          onDoubleClick={() => useAppStore.getState().toggleFocusMode()}
          role="separator"
          aria-orientation="vertical"
        />
        <div className="editor-col">
          <CenterPane />
        </div>
        {showAi && (
          <div
            className="resize-handle"
            onMouseDown={() => setDragging('ai')}
            role="separator"
            aria-orientation="vertical"
          />
        )}
        {/* The AI panel stays mounted even when closed so per-note webviews keep
            their state; the door button just hides it via CSS. */}
        <div className={`ai-col${showAi ? '' : ' hidden'}`} style={{ width: showAi ? aiWidth : 0 }}>
          <AIPanel />
        </div>
      </div>
      {dragging && <div className="drag-overlay" />}
      <StatusBar />
      <CommandPalette commands={commands} />
      <WorkFolderModal />
    </div>
  )
}
