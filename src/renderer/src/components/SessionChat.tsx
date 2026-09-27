import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrainstormSession } from '@shared/types'
import { useWebviewBridge } from '../hooks/useWebviewBridge'
import { useAppStore } from '../store/appStore'

const delay = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms))

interface Props {
  session: BrainstormSession
  isActive: boolean
  preloadPath: string
  onToast: (msg: string) => void
}

/**
 * One brainstorm's private ChatGPT panel. Each session gets its own <webview>
 * and bridge; instances stay mounted (hidden when inactive) so switching notes
 * never reloads or loses conversation state. Message/URL capture, recovery, and
 * context-menu actions are all scoped to THIS session.
 */
export default function SessionChat({ session, isActive, preloadPath, onToast }: Props): JSX.Element {
  const { webviewRef, isReady, sendOperation, onMessage, onUrl, onAddToNotes, onSaveAsIdea, navigateAndWait } = useWebviewBridge()

  // Freeze the initial src so a captured URL change never remounts/reloads it.
  const [initialSrc] = useState(session.chatUrl ?? 'https://chatgpt.com/')

  const recoveringRef = useRef(false)
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive

  const flash = useCallback((msg: string) => onToast(msg), [onToast])

  // Persist this session's conversation URL when it changes.
  useEffect(() => {
    const unsub = onUrl((url) => {
      if (/\/c\//.test(url)) useAppStore.getState().setChatUrl(session.id, url)
    })
    return unsub
  }, [onUrl, session.id])

  // Listen for in-page button clicks directly inside the ChatGPT site
  useEffect(() => {
    const unsubNotes = onAddToNotes((text) => {
      const st = useAppStore.getState()
      const current = st.sessions.find((s) => s.id === session.id)?.notes || ''
      const next = current ? `${current}\n\n${text}` : text
      st.setNotes(session.id, next)
      flash('Appended raw Markdown from ChatGPT site to notes')
    })
    const unsubIdea = onSaveAsIdea((text) => {
      const st = useAppStore.getState()
      st.addIdea(session.id, { text, source: 'ai' })
      flash('Saved Idea from ChatGPT site')
    })
    return () => {
      unsubNotes()
      unsubIdea()
    }
  }, [onAddToNotes, onSaveAsIdea, session.id, flash])

  const pendingActionOriginalTextRef = useRef<string | null>(null)

  // Capture settled replies into this session's transcript (suppressed during
  // recovery, when replies are just "waiting" acknowledgements).
  useEffect(() => {
    const unsubscribe = onMessage((data) => {
      if (recoveringRef.current) return
      const st = useAppStore.getState()
      st.addMessage(session.id, { role: 'assistant', content: data.text, timestamp: data.timestamp })
      // A reply to a notes context-menu action is offered as an inline
      // suggestion in the editor rather than just landing in the transcript.
      if (pendingActionOriginalTextRef.current) {
        st.setInlineSuggestion({
          id: `sug_${Date.now()}`,
          sessionId: session.id,
          originalText: pendingActionOriginalTextRef.current,
          suggestedText: data.text,
          timestamp: data.timestamp
        })
        pendingActionOriginalTextRef.current = null
      }

      if (isActiveRef.current) {
        // Handle consolidation progression
        const cs = st.consolidationState
        if (cs && cs.active && cs.sessionId === session.id) {
          if (cs.currentChunkIndex < cs.totalChunks - 1) {
            st.advanceConsolidation()
            flash(`Consolidating… part ${cs.currentChunkIndex + 2} of ${cs.totalChunks}`)
          } else {
            st.setNotes(session.id, data.text)
            st.cancelConsolidation()
            flash('Notes consolidated')
          }
        }
      }
    })
    return unsubscribe
  }, [onMessage, session.id, flash])

  // Send a prompt to this session and record our side of the turn.
  const sendPrompt = useCallback(
    (prompt: string) => {
      if (!isReady) {
        flash('Webview not ready yet')
        return
      }
      sendOperation(JSON.stringify({ type: 'fillAndSubmit', text: prompt, delayMs: 800 }))
      useAppStore.getState().addMessage(session.id, {
        role: 'user',
        content: prompt,
        timestamp: Date.now()
      })
    },
    [isReady, sendOperation, session.id, flash]
  )

  // Resolves when the next settled reply arrives — gates recovery chunks.
  const waitForReply = useCallback(
    (timeoutMs = 180000): Promise<void> =>
      new Promise((resolve) => {
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          off()
          resolve()
        }
        const off = onMessage(finish)
        window.setTimeout(finish, timeoutMs)
      }),
    [onMessage]
  )

  const runRecovery = useCallback(
    async (chunks: string[]): Promise<void> => {
      if (chunks.length === 0) return
      recoveringRef.current = true
      useAppStore.getState().setRecovery({ sessionId: session.id, total: chunks.length, sent: 0 })
      flash('Recovering conversation…')
      try {
        await navigateAndWait('https://chatgpt.com/') // fresh chat — no cross-convo overlap
        await delay(1500)
        for (let i = 0; i < chunks.length; i++) {
          const replyDone = waitForReply()
          sendOperation(JSON.stringify({ type: 'fillAndSubmit', text: chunks[i], delayMs: 900 }))
          useAppStore.getState().setRecovery({ sessionId: session.id, total: chunks.length, sent: i + 1 })
          await replyDone // only advance once the AI has finished
        }
        flash('Conversation recovered')
      } catch (err) {
        console.error('[SessionChat] recovery failed:', err)
        flash('Recovery failed')
      } finally {
        recoveringRef.current = false
        useAppStore.getState().setRecovery(null)
      }
    },
    [navigateAndWait, sendOperation, waitForReply, flash, session.id]
  )

  // Pick up recovery requests targeting this session.
  const recoveryRequest = useAppStore((s) => s.recoveryRequest)
  const handledRecovery = useRef<number | null>(null)
  useEffect(() => {
    if (!recoveryRequest || recoveryRequest.sessionId !== session.id) return
    if (recoveringRef.current || handledRecovery.current === recoveryRequest.nonce) return
    handledRecovery.current = recoveryRequest.nonce
    const { chunks } = recoveryRequest
    useAppStore.getState().clearRecoveryRequest()
    void runRecovery(chunks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryRequest?.nonce])

  // Pick up AI-action requests (Critique/Expand from the notes context menu).
  const aiActionRequest = useAppStore((s) => s.aiActionRequest)
  const handledAction = useRef<number | null>(null)
  useEffect(() => {
    if (!aiActionRequest || aiActionRequest.sessionId !== session.id) return
    if (handledAction.current === aiActionRequest.nonce) return
    handledAction.current = aiActionRequest.nonce
    const { prompt, originalText } = aiActionRequest as typeof aiActionRequest & { originalText?: string }
    pendingActionOriginalTextRef.current = originalText || null
    useAppStore.getState().clearAiActionRequest()
    sendPrompt(prompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiActionRequest?.nonce])

  return (
    <webview
      key={`${session.id}:${preloadPath}`}
      ref={webviewRef as never}
      src={initialSrc}
      preload={preloadPath}
      partition="persist:chatgpt-guest"
      webpreferences="contextIsolation=yes,nodeIntegration=no"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        border: 'none',
        display: isActive ? 'flex' : 'none'
      }}
    />
  )
}
