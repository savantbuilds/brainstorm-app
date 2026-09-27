import { useCallback, useEffect, useRef, useState } from 'react'
import type { AIAction } from '@shared/types'
import SessionChat from './SessionChat'
import { buildBrainstormPrompt } from '../lib/prompt'
import { findSession, useAppStore } from '../store/appStore'

// Each session's panel is a real Chromium <webview> — tens of MB of resident
// memory apiece. Keeping every session ever visited mounted is what made the
// app get slower the longer you used it, so only the most recent few stay
// alive. Older panels are torn down; their conversation is recoverable from the
// saved URL the moment you return to them.
const MAX_LIVE_PANELS = 3

const QUICK_ACTIONS: { action: AIAction; label: string; title: string }[] = [
  { action: 'brainstorm', label: 'Brainstorm', title: 'Generate fresh ideas around this topic' },
  { action: 'expand', label: 'Expand', title: 'Expand on the most promising directions in your notes' },
  { action: 'critique', label: 'Critique', title: "Play devil's advocate on your notes" },
  { action: 'ask', label: 'Send notes', title: 'Send your current notes to ChatGPT as context' }
]

export default function AIPanel(): JSX.Element {
  const [toast, setToast] = useState<string | null>(null)
  const [preloadPath, setPreloadPath] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const toastTimer = useRef<number>()

  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const requestAiAction = useAppStore((s) => s.requestAiAction)

  const active = useAppStore((s) => findSession(s.sessions, s.activeSessionId))

  // Resolve absolute preload file URL for webview injection.
  useEffect(() => {
    let cancelled = false
    window.api.getPreloadPath('chatgpt.js').then((path) => {
      if (!cancelled) setPreloadPath(path)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Most-recently-visited session ids, capped. Ids for deleted sessions are
  // filtered out so a deleted brainstorm can't hold a panel open.
  const [liveIds, setLiveIds] = useState<string[]>([])

  useEffect(() => {
    if (!activeSessionId) return
    setLiveIds((prev) => {
      if (prev[0] === activeSessionId) return prev
      return [activeSessionId, ...prev.filter((id) => id !== activeSessionId)].slice(0, MAX_LIVE_PANELS)
    })
  }, [activeSessionId])

  // Drop live panels whose session was deleted.
  const sessionIds = useAppStore((s) => s.sessions.map((x) => x.id))
  useEffect(() => {
    const alive = new Set(sessionIds)
    setLiveIds((prev) => {
      const next = prev.filter((id) => alive.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [sessionIds])

  const flash = useCallback((msg: string): void => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2400)
  }, [])

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  const sendFreeform = useCallback((): void => {
    const text = prompt.trim()
    if (!text || !active) return
    requestAiAction(active.id, text)
    setPrompt('')
    flash('Sent to ChatGPT')
  }, [prompt, active, requestAiAction, flash])

  const runQuickAction = useCallback(
    (action: AIAction): void => {
      if (!active) return
      requestAiAction(
        active.id,
        buildBrainstormPrompt({ topic: active.title, notes: active.notes, action })
      )
      flash(`Sent: ${action}`)
    },
    [active, requestAiAction, flash]
  )

  // Rendered in most-recent-first order. Each panel subscribes to its own
  // session, so editing notes in one session never re-renders this component
  // or the other panels.
  return (
    <div className="ai-panel">
      <div className="ai-toolbar">
        <span className="ai-title">AI · {active ? active.title : 'no brainstorm'}</span>
      </div>

      {active && (
        <div className="ai-quickbar">
          {QUICK_ACTIONS.map((q) => (
            <button
              key={q.action}
              className="ai-quick-btn"
              title={q.title}
              disabled={q.action !== 'brainstorm' && !active.notes.trim()}
              onClick={() => runQuickAction(q.action)}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}

      <div className="ai-webview-wrap">
        {preloadPath && liveIds.length > 0 ? (
          liveIds.map((id) => (
            <SessionChat
              key={id}
              sessionId={id}
              isActive={id === activeSessionId}
              preloadPath={preloadPath}
              onToast={flash}
            />
          ))
        ) : (
          <div className="ai-loading">
            {active ? 'Loading AI panel…' : 'Select or create a brainstorm.'}
          </div>
        )}
        {toast && <div className="ai-toast">{toast}</div>}
      </div>

      {active && (
        <div className="ai-composer">
          <textarea
            ref={inputRef}
            className="ai-composer-input"
            value={prompt}
            placeholder="Ask ChatGPT…  (Enter to send, Shift+Enter for newline)"
            rows={2}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendFreeform()
              }
            }}
          />
          <button
            className="ai-composer-send"
            onClick={sendFreeform}
            disabled={!prompt.trim()}
            title="Send to ChatGPT (Enter)"
          >
            ➤
          </button>
        </div>
      )}

      <div className="ai-footnote">
        Highlight text in the notes and right-click for Critique / Expand, or use the buttons above.
      </div>
    </div>
  )
}
