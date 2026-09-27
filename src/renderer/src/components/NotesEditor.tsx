import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Idea } from '@shared/types'
import { buildSelectionPrompt } from '../lib/prompt'
import { useAppStore } from '../store/appStore'

interface MenuState {
  x: number
  y: number
  selection: string
}

interface Heading {
  level: number
  text: string
  pos: number
  order: number
}

// A single collapsible idea. Starts collapsed to a one-line preview so long
// ideas don't dominate the pane; click the header to expand.
function IdeaCard({
  idea,
  onRemove,
  onPromote
}: {
  idea: Idea
  onRemove: () => void
  onPromote: () => void
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(true)
  const firstLine = idea.text.trim().split('\n')[0]

  return (
    <div className={`idea-card idea-${idea.source}${collapsed ? ' collapsed' : ''}`}>
      <div className="idea-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="idea-caret" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="idea-source">{idea.source === 'ai' ? 'AI' : 'Me'}</span>
        <span className="idea-preview" title={firstLine}>
          {firstLine}
        </span>
        <button
          className="idea-promote"
          title="Move this idea into your notes"
          onClick={(e) => {
            e.stopPropagation()
            onPromote()
          }}
        >
          → Notes
        </button>
        <button
          className="idea-del"
          title="Remove idea"
          aria-label="Remove idea"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          ×
        </button>
      </div>
      {!collapsed && <div className="idea-text">{idea.text}</div>}
    </div>
  )
}

// Parse ATX headings out of the raw markdown for the outline rail.
function parseHeadings(notes: string): Heading[] {
  const out: Heading[] = []
  let pos = 0
  let order = 0
  for (const line of notes.split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      out.push({ level: m[1].length, text: m[2].trim(), pos, order: order++ })
    }
    pos += line.length + 1
  }
  return out
}

export default function NotesEditor(): JSX.Element {
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const setNotes = useAppStore((s) => s.setNotes)
  const renameSession = useAppStore((s) => s.renameSession)
  const removeIdea = useAppStore((s) => s.removeIdea)
  const promoteIdeaToNotes = useAppStore((s) => s.promoteIdeaToNotes)
  const newSession = useAppStore((s) => s.newSession)
  const requestAiAction = useAppStore((s) => s.requestAiAction)
  const startConsolidation = useAppStore((s) => s.startConsolidation)
  const cancelConsolidation = useAppStore((s) => s.cancelConsolidation)
  const consolidationState = useAppStore((s) => s.consolidationState)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const scrollRatioRef = useRef<number>(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  const active = sessions.find((s) => s.id === activeSessionId) ?? null

  const headings = useMemo(() => parseHeadings(active?.notes ?? ''), [active?.notes])
  const stats = useMemo(() => {
    const text = (active?.notes ?? '').trim()
    const words = text ? text.split(/\s+/).length : 0
    const chars = active?.notes.length ?? 0
    const mins = Math.max(1, Math.round(words / 200))
    return { words, chars, mins }
  }, [active?.notes])

  // Brief "Saved" pulse whenever the notes content settles after an edit.
  useEffect(() => {
    if (!active) return
    setSavedFlash(true)
    const t = window.setTimeout(() => setSavedFlash(false), 900)
    return () => window.clearTimeout(t)
  }, [active?.notes])

  const switchMode = (nextMode: 'edit' | 'preview'): void => {
    if (nextMode === mode) return
    let ratio = 0
    if (mode === 'edit' && textareaRef.current) {
      const el = textareaRef.current
      const maxScroll = el.scrollHeight - el.clientHeight
      ratio = maxScroll > 0 ? el.scrollTop / maxScroll : 0
    } else if (mode === 'preview' && previewRef.current) {
      const el = previewRef.current
      const maxScroll = el.scrollHeight - el.clientHeight
      ratio = maxScroll > 0 ? el.scrollTop / maxScroll : 0
    }
    scrollRatioRef.current = ratio
    setMode(nextMode)
  }

  useEffect(() => {
    const ratio = scrollRatioRef.current
    requestAnimationFrame(() => {
      if (mode === 'edit' && textareaRef.current) {
        const el = textareaRef.current
        el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
      } else if (mode === 'preview' && previewRef.current) {
        const el = previewRef.current
        el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
      }
    })
  }, [mode])

  // Close the context menu on any outside interaction / scroll / Escape.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const openMenu = (e: React.MouseEvent<HTMLElement>): void => {
    e.preventDefault()
    let selection = ''
    if (textareaRef.current && mode === 'edit') {
      selection = textareaRef.current.value.substring(
        textareaRef.current.selectionStart,
        textareaRef.current.selectionEnd
      )
    } else {
      selection = window.getSelection()?.toString() || ''
    }
    setMenu({ x: e.clientX, y: e.clientY, selection })
  }

  const exec = (command: string): void => {
    if (mode === 'edit') {
      textareaRef.current?.focus()
      document.execCommand(command)
    }
    setMenu(null)
  }

  // --- Markdown formatting helpers (operate on the textarea selection) ------
  const surround = (before: string, after = before): void => {
    const ta = textareaRef.current
    if (!ta || !active) return
    const { selectionStart: s, selectionEnd: e, value } = ta
    const sel = value.slice(s, e)
    const next = value.slice(0, s) + before + sel + after + value.slice(e)
    setNotes(active.id, next)
    requestAnimationFrame(() => {
      ta.focus()
      const ns = s + before.length
      ta.setSelectionRange(ns, ns + sel.length)
    })
  }

  const prefixLines = (prefix: string): void => {
    const ta = textareaRef.current
    if (!ta || !active) return
    const { selectionStart: s, selectionEnd: e, value } = ta
    const lineStart = value.lastIndexOf('\n', s - 1) + 1
    let lineEnd = value.indexOf('\n', e)
    if (lineEnd === -1) lineEnd = value.length
    const block = value.slice(lineStart, lineEnd)
    const newBlock = block
      .split('\n')
      .map((l) => (l.startsWith(prefix) ? l : prefix + l))
      .join('\n')
    const next = value.slice(0, lineStart) + newBlock + value.slice(lineEnd)
    setNotes(active.id, next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(lineStart, lineStart + newBlock.length)
    })
  }

  const insertLink = (): void => {
    const ta = textareaRef.current
    if (!ta || !active) return
    const { selectionStart: s, selectionEnd: e, value } = ta
    const sel = value.slice(s, e) || 'text'
    const md = `[${sel}](url)`
    const next = value.slice(0, s) + md + value.slice(e)
    setNotes(active.id, next)
    requestAnimationFrame(() => {
      ta.focus()
      // Select the "url" placeholder for quick replacement.
      const urlStart = s + md.length - 4
      ta.setSelectionRange(urlStart, urlStart + 3)
    })
  }

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      surround('**')
    } else if (mod && e.key.toLowerCase() === 'i') {
      e.preventDefault()
      surround('*')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const ta = textareaRef.current
      if (!ta || !active) return
      const { selectionStart: s, selectionEnd: en, value } = ta
      const next = value.slice(0, s) + '  ' + value.slice(en)
      setNotes(active.id, next)
      requestAnimationFrame(() => {
        ta.focus()
        ta.setSelectionRange(s + 2, s + 2)
      })
    }
  }

  const jumpToHeading = (h: Heading): void => {
    if (mode === 'preview' && previewRef.current) {
      const els = previewRef.current.querySelectorAll('h1,h2,h3,h4,h5,h6')
      els[h.order]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (textareaRef.current) {
      const ta = textareaRef.current
      ta.focus()
      ta.setSelectionRange(h.pos, h.pos)
      // Approximate scroll so the heading lands near the top.
      const linesBefore = ta.value.slice(0, h.pos).split('\n').length
      const lineHeight = 22
      ta.scrollTop = Math.max(0, (linesBefore - 2) * lineHeight)
    }
    setOutlineOpen(false)
  }

  const exportMarkdown = async (): Promise<void> => {
    if (!active) return
    const parts = [`# ${active.title || 'Untitled brainstorm'}`, '', active.notes.trim()]
    if (active.ideas.length) {
      parts.push('', '---', '', '## Captured ideas', '')
      for (const idea of active.ideas) {
        parts.push(`- **[${idea.source === 'ai' ? 'AI' : 'Me'}]** ${idea.text.replace(/\n/g, ' ')}`)
      }
    }
    const safe = (active.title || 'brainstorm').replace(/[^\w\- ]+/g, '').trim() || 'brainstorm'
    await window.api.exportFile(`${safe}.md`, parts.join('\n'))
  }

  const inlineSuggestion = useAppStore((s) => s.inlineSuggestion)
  const clearInlineSuggestion = useAppStore((s) => s.clearInlineSuggestion)

  const aiAction = (kind: 'critique' | 'expand'): void => {
    if (!menu?.selection.trim() || !active) return
    const selectionText = menu.selection.trim()
    requestAiAction(active.id, buildSelectionPrompt(kind, selectionText), selectionText)
    setMenu(null)
  }

  const handleReplaceSelection = (): void => {
    if (!active || !inlineSuggestion) return
    const { originalText, suggestedText } = inlineSuggestion
    let updatedNotes = active.notes
    if (originalText && updatedNotes.includes(originalText)) {
      updatedNotes = updatedNotes.replace(originalText, suggestedText)
    } else {
      updatedNotes = `${updatedNotes}\n\n${suggestedText}`
    }
    setNotes(active.id, updatedNotes)
    clearInlineSuggestion()
  }

  const handleInsertBelow = (): void => {
    if (!active || !inlineSuggestion) return
    const { originalText, suggestedText } = inlineSuggestion
    let updatedNotes = active.notes
    if (originalText && updatedNotes.includes(originalText)) {
      updatedNotes = updatedNotes.replace(originalText, `${originalText}\n\n${suggestedText}`)
    } else {
      updatedNotes = `${updatedNotes}\n\n${suggestedText}`
    }
    setNotes(active.id, updatedNotes)
    clearInlineSuggestion()
  }

  if (!active) {
    return (
      <div className="editor-empty">
        <div>
          <div className="editor-empty-icon" aria-hidden="true">
            ✦
          </div>
          <h1>Nothing to brainstorm yet</h1>
          <p className="muted">Create a brainstorm from the sidebar to get started.</p>
          <button className="btn-primary" onClick={() => newSession()} style={{ marginTop: 12 }}>
            New brainstorm
          </button>
        </div>
      </div>
    )
  }

  const currentSuggestion =
    inlineSuggestion && inlineSuggestion.sessionId === active.id ? inlineSuggestion : null

  const handleDoubleClickReadingView = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    if (!active) return

    const selection = window.getSelection()
    const selectedText = selection ? selection.toString().trim() : ''

    let targetIndex = -1

    if (selectedText && active.notes.includes(selectedText)) {
      targetIndex = active.notes.indexOf(selectedText)
    } else if (selection && selection.anchorNode) {
      const nodeText = (selection.anchorNode.textContent || '').trim()
      if (nodeText && active.notes.includes(nodeText)) {
        targetIndex = active.notes.indexOf(nodeText)
      }
    }

    switchMode('edit')

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        if (targetIndex >= 0) {
          const length = selectedText ? selectedText.length : 0
          textareaRef.current.setSelectionRange(targetIndex, targetIndex + length)
        }
      }
    })
  }

  return (
    <div className="notes">
      <div className="notes-header-row">
        <input
          className="notes-title"
          value={active.title}
          placeholder="Brainstorm title…"
          onChange={(e) => renameSession(active.id, e.target.value)}
        />
        <div className="obsidian-mode-toggle">
          <button
            className={`mode-btn${mode === 'edit' ? ' active' : ''}`}
            onClick={() => switchMode('edit')}
            title="Edit Source Mode"
          >
            ✏️ Edit
          </button>
          <button
            className={`mode-btn${mode === 'preview' ? ' active' : ''}`}
            onClick={() => switchMode('preview')}
            title="Reading View Mode (Rendered Markdown)"
          >
            👁️ Reading View
          </button>
          <button
            className={`mode-btn${outlineOpen ? ' active' : ''}`}
            onClick={() => setOutlineOpen((o) => !o)}
            title="Outline / table of contents"
            disabled={headings.length === 0}
          >
            ☰ Outline
          </button>
          <div className="notes-more-menu-wrap">
            <button
              className="mode-btn notes-more-btn"
              onClick={() => setActionsMenuOpen((o) => !o)}
              title="More Actions"
            >
              ⋮
            </button>
            {actionsMenuOpen && (
              <div className="notes-more-dropdown">
                <button
                  onClick={() => {
                    setActionsMenuOpen(false)
                    startConsolidation(active.id)
                  }}
                  disabled={
                    !active.notes.trim() ||
                    (consolidationState?.active && consolidationState?.sessionId === active.id)
                  }
                  title="Reformat notebook into a clean, professional document using AI"
                >
                  🪄 Consolidate
                </button>
                <button
                  onClick={() => {
                    setActionsMenuOpen(false)
                    void exportMarkdown()
                  }}
                  disabled={!active.notes.trim()}
                  title="Export this brainstorm as a Markdown file"
                >
                  ⬇ Export Markdown
                </button>
                <button
                  onClick={() => {
                    setActionsMenuOpen(false)
                    void window.api.copyToClipboard(active.notes)
                  }}
                  disabled={!active.notes.trim()}
                  title="Copy all notes to the clipboard"
                >
                  📋 Copy all
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {mode === 'edit' && (
        <div className="notes-toolbar">
          <button title="Bold (Ctrl+B)" onClick={() => surround('**')}>
            <b>B</b>
          </button>
          <button title="Italic (Ctrl+I)" onClick={() => surround('*')}>
            <i>I</i>
          </button>
          <button title="Inline code" onClick={() => surround('`')}>
            {'</>'}
          </button>
          <span className="notes-toolbar-sep" />
          <button title="Heading" onClick={() => prefixLines('## ')}>
            H
          </button>
          <button title="Bullet list" onClick={() => prefixLines('- ')}>
            •
          </button>
          <button title="Numbered list" onClick={() => prefixLines('1. ')}>
            1.
          </button>
          <button title="Quote" onClick={() => prefixLines('> ')}>
            ❝
          </button>
          <button title="Checklist" onClick={() => prefixLines('- [ ] ')}>
            ☑
          </button>
          <button title="Link" onClick={insertLink}>
            🔗
          </button>
        </div>
      )}

      {outlineOpen && headings.length > 0 && (
        <div className="notes-outline">
          <div className="notes-outline-head">Outline</div>
          {headings.map((h, i) => (
            <button
              key={i}
              className="notes-outline-item"
              style={{ paddingLeft: 8 + (h.level - 1) * 14 }}
              onClick={() => jumpToHeading(h)}
              title={h.text}
            >
              {h.text || '(untitled heading)'}
            </button>
          ))}
        </div>
      )}

      {consolidationState &&
        consolidationState.active &&
        consolidationState.sessionId === active.id && (
          <div className="consolidation-progress-bar">
            <div className="consolidation-progress-info">
              <span>
                🪄 Consolidating notes… Part {consolidationState.currentChunkIndex + 1} of{' '}
                {consolidationState.totalChunks}
              </span>
              <button
                className="btn-ghost"
                onClick={() => cancelConsolidation()}
                title="Cancel consolidation"
              >
                ×
              </button>
            </div>
            <div className="consolidation-track">
              <div
                className="consolidation-fill"
                style={{
                  width: `${Math.round(
                    ((consolidationState.currentChunkIndex + 1) /
                      consolidationState.totalChunks) *
                      100
                  )}%`
                }}
              />
            </div>
          </div>
        )}

      {currentSuggestion && (
        <div className="inline-suggestion-card">
          <div className="inline-suggestion-header">
            <span>✨ AI Suggestion</span>
            <button className="btn-ghost" onClick={() => clearInlineSuggestion()}>
              ×
            </button>
          </div>
          <div className="inline-suggestion-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {currentSuggestion.suggestedText}
            </ReactMarkdown>
          </div>
          <div className="inline-suggestion-actions">
            <button className="btn-primary" onClick={handleReplaceSelection}>
              Replace Selection
            </button>
            <button className="btn-secondary" onClick={handleInsertBelow}>
              Insert Below
            </button>
            <button className="btn-ghost" onClick={() => clearInlineSuggestion()}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {mode === 'edit' ? (
        <textarea
          ref={textareaRef}
          className="notes-body"
          value={active.notes}
          placeholder="Jot down your thoughts in Markdown (supports # headings, - bullet lists, **bold**, code blocks)..."
          onChange={(e) => setNotes(active.id, e.target.value)}
          onKeyDown={onEditorKeyDown}
          onContextMenu={openMenu}
        />
      ) : (
        <div
          ref={previewRef}
          className="notes-body notes-preview markdown-body"
          onContextMenu={openMenu}
          onDoubleClick={handleDoubleClickReadingView}
          title="Double-click anywhere to switch to Edit mode at this position"
        >
          {active.notes.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{active.notes}</ReactMarkdown>
          ) : (
            <div className="muted" style={{ padding: '20px 0' }}>
              *No notes content yet. Switch to Edit mode or double-click to start writing.*
            </div>
          )}
        </div>
      )}

      <div className="notes-meta">
        <span className={`notes-saved${savedFlash ? ' show' : ''}`}>✓ Saved</span>
        <span className="notes-meta-spacer" />
        <span>{stats.words} words</span>
        <span>{stats.chars} chars</span>
        <span>~{stats.mins} min read</span>
      </div>

      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button className="ctx-menu-item" onClick={() => exec('cut')} disabled={!menu.selection}>
            Cut
          </button>
          <button className="ctx-menu-item" onClick={() => exec('copy')} disabled={!menu.selection}>
            Copy
          </button>
          <button className="ctx-menu-item" onClick={() => exec('paste')}>
            Paste
          </button>
          <button className="ctx-menu-item" onClick={() => exec('selectAll')}>
            Select All
          </button>
          <div className="ctx-menu-sep" />
          <button
            className="ctx-menu-item ai"
            onClick={() => aiAction('critique')}
            disabled={!menu.selection.trim()}
          >
            Critique Selection
          </button>
          <button
            className="ctx-menu-item ai"
            onClick={() => aiAction('expand')}
            disabled={!menu.selection.trim()}
          >
            Expand Selection
          </button>
        </div>
      )}

      {active.ideas.length > 0 && (
        <div className="ideas">
          <div className="ideas-header">Captured ideas ({active.ideas.length})</div>
          <div className="ideas-list">
            {active.ideas.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                onRemove={() => removeIdea(active.id, idea.id)}
                onPromote={() => {
                  promoteIdeaToNotes(active.id, idea.id)
                  setSavedFlash(true)
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
