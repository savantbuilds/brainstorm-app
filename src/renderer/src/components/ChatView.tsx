import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { findSession, useAppStore } from '../store/appStore'
import type { ChatMessage } from '@shared/types'
import {
  buildRecoveryChunks,
  buildRecoveryTranscript,
  RECOVERY_WORD_THRESHOLD,
  wordCount
} from '../lib/recovery'

// A saved transcript can run to tens of thousands of words, and rebuilding the
// recovery text to measure it is expensive enough to be worth memoising against
// the message list rather than redoing it on every render.
function useRecoveryInfo(messages: ChatMessage[]): {
  words: number
  chunked: boolean
  chunks: string[]
} {
  return useMemo(() => {
    if (messages.length === 0) return { words: 0, chunked: false, chunks: [] }
    const words = wordCount(buildRecoveryTranscript(messages))
    return {
      words,
      chunked: words >= RECOVERY_WORD_THRESHOLD,
      chunks: buildRecoveryChunks(messages)
    }
  }, [messages])
}

const EMPTY_MESSAGES: never[] = []

export default function ChatView(): JSX.Element {
  const active = useAppStore((s) => findSession(s.sessions, s.activeSessionId))
  const clearMessages = useAppStore((s) => s.clearMessages)
  const requestRecovery = useAppStore((s) => s.requestRecovery)
  const recovery = useAppStore((s) => s.recovery)
  const setNotes = useAppStore((s) => s.setNotes)
  const addIdea = useAppStore((s) => s.addIdea)
  const toggleBookmarkMessage = useAppStore((s) => s.toggleBookmarkMessage)

  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number>()

  const messages = active?.messages ?? EMPTY_MESSAGES
  const { words, chunked, chunks } = useRecoveryInfo(messages)

  const flash = useCallback((msg: string): void => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2400)
  }, [])

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  if (!active) {
    return <div className="editor-empty muted">No brainstorm selected.</div>
  }

  const recovering = recovery?.sessionId === active.id
  const progressPct = recovery && recovery.total > 0 ? (recovery.sent / recovery.total) * 100 : 0

  const recover = (): void => {
    if (!messages.length) return
    requestRecovery(active.id, chunks)
  }

  const toggleExpand = (index: number): void => {
    setExpandedIndices((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const expandAll = (): void => {
    setExpandedIndices(new Set(active.messages.map((_, i) => i)))
  }

  const collapseAll = (): void => {
    setExpandedIndices(new Set())
  }

  const copyRawMarkdown = (text: string): void => {
    void window.api.copyToClipboard(text)
    flash('Copied raw Markdown to clipboard')
  }

  const appendRawToNotes = (text: string): void => {
    const next = active.notes ? `${active.notes}\n\n${text}` : text
    setNotes(active.id, next)
    flash('Appended raw Markdown to notes')
  }

  const saveMessageAsIdea = (text: string): void => {
    // Idea card takes first non-empty line as concise title preview
    const cleanText = text.replace(/^#+\s+/gm, '').trim()
    addIdea(active.id, { text: cleanText, source: 'ai' })
    flash('Saved as idea')
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="chat-count">
          {active.messages.length} message{active.messages.length === 1 ? '' : 's'} · saved locally
          {active.messages.some((m) => m.bookmarked)
            ? ` (${active.messages.filter((m) => m.bookmarked).length} bookmarked)`
            : ''}
        </span>
        <div className="chat-head-actions">
          {active.messages.length > 0 && (
            <>
              <button
                className="chat-toggle-all"
                onClick={expandedIndices.size === active.messages.length ? collapseAll : expandAll}
                title="Toggle all messages expanded/collapsed"
              >
                {expandedIndices.size === active.messages.length ? 'Collapse All' : 'Expand All'}
              </button>
              <button
                className="chat-recover"
                onClick={recover}
                disabled={recovering}
                title={
                  chunked
                    ? `Long transcript (~${words} words) — will be re-injected in chunks`
                    : 'Re-inject this conversation into a fresh ChatGPT chat'
                }
              >
                {recovering ? 'Recovering…' : 'Recover convo'}
              </button>
              <button
                className="chat-clear"
                onClick={() => clearMessages(active.id)}
                disabled={recovering}
                title="Clear transcript"
              >
                Clear
              </button>
            </>
          )}
        </div>
      </div>

      {toast && <div className="ai-toast">{toast}</div>}

      {recovering && (
        <div className="recovery-bar">
          <div className="recovery-bar-label">
            Re-injecting context into a fresh chat — chunk {recovery?.sent} of {recovery?.total}
          </div>
          <div className="recovery-track">
            <div className="recovery-fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}

      <div className="chat-body">
        {active.messages.length === 0 ? (
          <div className="chat-empty">
            No saved messages yet. Prompts you send from the AI panel and the replies that come back
            are recorded here automatically.
          </div>
        ) : (
          active.messages.map((m, i) => {
            const isExpanded = expandedIndices.has(i)
            const firstLine = m.content.trim().split('\n')[0].slice(0, 100)

            return (
              <div
                key={i}
                className={`chat-msg chat-${m.role}${m.bookmarked ? ' bookmarked' : ''}${
                  isExpanded ? ' expanded' : ' collapsed'
                }`}
              >
                <div className="chat-msg-header" onClick={() => toggleExpand(i)}>
                  <div className="chat-msg-header-left">
                    <span className="chat-caret">{isExpanded ? '▾' : '▸'}</span>
                    <span className="chat-role">{m.role === 'user' ? 'You' : 'ChatGPT'}</span>
                    {!isExpanded && <span className="chat-preview">{firstLine}</span>}
                  </div>
                  <div className="chat-msg-header-right" onClick={(e) => e.stopPropagation()}>
                    <span className="chat-time">{new Date(m.timestamp).toLocaleTimeString()}</span>
                    <button
                      className={`chat-bookmark-btn${m.bookmarked ? ' active' : ''}`}
                      title={m.bookmarked ? 'Remove bookmark' : 'Bookmark message for priority recovery'}
                      onClick={() => toggleBookmarkMessage(active.id, i)}
                    >
                      {m.bookmarked ? '📌' : '📍'}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <>
                    <div className="chat-text markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>

                    <div className="chat-turn-toolbar">
                      <button onClick={() => copyRawMarkdown(m.content)} title="Copy exact raw Markdown text">
                        📋 Copy Raw
                      </button>
                      <button onClick={() => appendRawToNotes(m.content)} title="Append raw Markdown to notes">
                        📝 Add to Notes
                      </button>
                      <button onClick={() => saveMessageAsIdea(m.content)} title="Save as single-line Idea">
                        💡 Save Idea
                      </button>
                    </div>
                  </>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
