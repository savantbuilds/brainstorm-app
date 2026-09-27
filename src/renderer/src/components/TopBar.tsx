import { useEffect, useRef, useState } from 'react'
import { useAppStore, selectActiveFolder } from '../store/appStore'

export default function TopBar(): JSX.Element {
  const [fileOpen, setFileOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const setFolderModal = useAppStore((s) => s.setFolderModal)
  const activeFolderId = useAppStore((s) => s.activeFolderId)
  const aiPanelVisible = useAppStore((s) => s.aiPanelVisible)
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel)
  const theme = useAppStore((s) => s.settings.theme)
  const focusMode = useAppStore((s) => s.settings.focusMode ?? false)
  const toggleFocusMode = useAppStore((s) => s.toggleFocusMode)
  const setCommandPalette = useAppStore((s) => s.setCommandPalette)

  const activeFolder = useAppStore(selectActiveFolder)

  // Close the File menu on any outside click.
  useEffect(() => {
    if (!fileOpen) return
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setFileOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [fileOpen])

  return (
    <div className="topbar">
      <div className="topbar-menu" ref={menuRef}>
        <button className="topbar-item" onClick={() => setFileOpen((o) => !o)}>
          File
        </button>
        {fileOpen && (
          <div className="topbar-dropdown">
            <button
              className="topbar-dropdown-item"
              onClick={() => {
                setFileOpen(false)
                setFolderModal(true)
              }}
            >
              Workspaces…
            </button>
            <button
              className="topbar-dropdown-item"
              disabled={!activeFolderId}
              onClick={() => {
                setFileOpen(false)
                useAppStore.getState().newSession()
              }}
            >
              New brainstorm
            </button>
          </div>
        )}
      </div>

      <div className="topbar-title">
        {activeFolder ? activeFolder.name : 'Brainstorm'}
      </div>

      <div className="topbar-spacer" />

      <button
        className="topbar-icon-btn"
        onClick={() => setCommandPalette(true)}
        title="Command palette (Ctrl+Shift+P)"
        aria-label="Command palette"
      >
        ⌘
      </button>
      <button
        className={`topbar-door${focusMode ? ' open' : ''}`}
        onClick={toggleFocusMode}
        title={focusMode ? 'Exit focus mode (Ctrl+Shift+F)' : 'Focus mode (Ctrl+Shift+F)'}
        aria-label="Toggle focus mode"
        aria-pressed={focusMode}
      >
        ◎
      </button>
      <button
        className="topbar-icon-btn"
        onClick={() =>
          useAppStore.getState().setSettings({ theme: theme === 'dark' ? 'light' : 'dark' })
        }
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label="Toggle theme"
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
      <button
        className={`topbar-door${aiPanelVisible ? ' open' : ''}`}
        onClick={toggleAiPanel}
        title={aiPanelVisible ? 'Close AI panel (Ctrl+Shift+A)' : 'Open AI panel (Ctrl+Shift+A)'}
        aria-label="Toggle AI panel"
        aria-pressed={aiPanelVisible}
      >
        ⌸
      </button>
    </div>
  )
}
