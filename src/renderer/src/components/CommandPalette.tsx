import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/appStore'

export interface Command {
  id: string
  label: string
  hint?: string
  /** Optional heading rendered above a contiguous run of commands. */
  group?: string
  run: () => void
}

// Subsequence match with a bonus for consecutive hits and word-boundary starts,
// so "ntog" finds "Go to: Notes" and "exp" ranks "Export" above "Expressions".
// Returns null when the query can't be matched at all.
function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()

  const direct = haystack.indexOf(needle)
  if (direct !== -1) {
    // A substring match near the start of the label is the strongest signal.
    return 1000 - direct + (direct === 0 ? 250 : 0)
  }

  let score = 0
  let cursor = 0
  let streak = 0
  for (const ch of needle) {
    const at = haystack.indexOf(ch, cursor)
    if (at === -1) return null
    streak = at === cursor ? streak + 1 : 0
    score += 10 + streak * 8
    if (at === 0 || haystack[at - 1] === ' ' || haystack[at - 1] === ':') score += 15
    cursor = at + 1
  }
  return score
}

export default function CommandPalette({ commands }: { commands: Command[] }): JSX.Element | null {
  const open = useAppStore((s) => s.commandPaletteOpen)
  const setOpen = useAppStore((s) => s.setCommandPalette)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim()
    return commands
      .map((c) => ({ c, score: fuzzyScore(c.label, q) }))
      .filter((x): x is { c: Command; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c)
  }, [commands, query])

  useEffect(() => {
    setSelected(0)
  }, [query])

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector('.palette-item.selected')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!open) return null

  const run = (cmd?: Command): void => {
    if (!cmd) return
    cmd.run()
    setOpen(false)
  }

  return (
    <div className="palette-overlay" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command or brainstorm name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const last = filtered.length - 1
            if (e.key === 'Escape') setOpen(false)
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelected((i) => (last < 0 ? 0 : Math.min(i + 1, last)))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelected((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Home') {
              e.preventDefault()
              setSelected(0)
            } else if (e.key === 'End') {
              e.preventDefault()
              setSelected(Math.max(last, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(filtered[selected])
            }
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {filtered.map((c, i) => (
            <div key={c.id}>
              {c.group && c.group !== filtered[i - 1]?.group && (
                <div className="palette-group">{c.group}</div>
              )}
              <div
                className={`palette-item${i === selected ? ' selected' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => run(c)}
                role="option"
                aria-selected={i === selected}
              >
                <span className="palette-item-label">{c.label}</span>
                {c.hint && <span className="palette-item-hint">{c.hint}</span>}
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div className="palette-empty">No matching commands</div>}
        </div>
      </div>
    </div>
  )
}
