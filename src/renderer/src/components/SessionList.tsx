import { useEffect, useMemo, useState } from 'react'
import type { BrainstormSession, SessionSort } from '@shared/types'
import { selectActiveFolder, useAppStore } from '../store/appStore'

const SORT_LABELS: Record<SessionSort, string> = {
  recent: 'Recently updated',
  alpha: 'Title (A–Z)',
  created: 'Newest created'
}

function sortSessions(list: BrainstormSession[], sort: SessionSort): BrainstormSession[] {
  const arr = [...list]
  arr.sort((a, b) => {
    // Starred sessions always float to the top.
    if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1
    if (sort === 'alpha') return (a.title || '').localeCompare(b.title || '')
    if (sort === 'created') return b.createdAt - a.createdAt
    return b.updatedAt - a.updatedAt
  })
  return arr
}

export default function SessionList({ width }: { width: number }): JSX.Element {
  const allSessions = useAppStore((s) => s.sessions)
  const activeFolderId = useAppStore((s) => s.activeFolderId)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const newSession = useAppStore((s) => s.newSession)
  const selectSession = useAppStore((s) => s.selectSession)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const toggleStarSession = useAppStore((s) => s.toggleStarSession)
  const sort = useAppStore((s) => s.settings.sessionSort ?? 'recent')
  const setSettings = useAppStore((s) => s.setSettings)

  const [rawQuery, setRawQuery] = useState('')

  // Debounced mirror of the query. Without this every keystroke re-lowercases
  // and scans every note body and idea in the folder, which is O(total text)
  // per character on a large workspace.
  const [query, setQuery] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(rawQuery), 120)
    return () => window.clearTimeout(timer)
  }, [rawQuery])

  // Search scope: this workspace only, or every workspace. Cross-workspace
  // search matters once someone has more than a handful of brainstorms and
  // can't remember which folder they filed something under.
  const [searchAll, setSearchAll] = useState(false)
  const folderName = useAppStore((s) => selectActiveFolder(s)?.name ?? 'this workspace')
  const folderNames = useAppStore((s) => {
    const map: Record<string, string> = {}
    for (const f of s.folders) map[f.id] = f.name
    return map
  })

  const sessions = useMemo(() => {
    const q = query.trim().toLowerCase()
    const scoped = searchAll ? allSessions : allSessions.filter((s) => s.folderId === activeFolderId)
    if (!q) return sortSessions(scoped, sort)
    const matched = scoped.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true
      if (s.notes.toLowerCase().includes(q)) return true
      return s.ideas.some((i) => i.text.toLowerCase().includes(q))
    })
    return sortSessions(matched, sort)
  }, [allSessions, activeFolderId, query, sort, searchAll])

  const cycleSort = (): void => {
    const order: SessionSort[] = ['recent', 'alpha', 'created']
    const next = order[(order.indexOf(sort) + 1) % order.length]
    setSettings({ sessionSort: next })
  }

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <span className="app-logo" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="3" width="15" height="18" rx="2" fill="#d7ba7d" />
            <rect x="4" y="3" width="15" height="4" rx="2" fill="#c9a95f" />
            <line x1="8" y1="10" x2="15" y2="10" stroke="#5a4a1f" strokeWidth="1.4" strokeLinecap="round" />
            <line x1="8" y1="13" x2="15" y2="13" stroke="#5a4a1f" strokeWidth="1.4" strokeLinecap="round" />
            <line x1="8" y1="16" x2="13" y2="16" stroke="#5a4a1f" strokeWidth="1.4" strokeLinecap="round" />
            <line x1="8" y1="2" x2="8" y2="6" stroke="#8a7333" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="12" y1="2" x2="12" y2="6" stroke="#8a7333" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="16" y1="2" x2="16" y2="6" stroke="#8a7333" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span>Brainstorms</span>
        </span>
        <button className="sidebar-new" onClick={() => newSession()} title="New brainstorm (Ctrl+N)">
          ＋
        </button>
      </div>

      <div className="sidebar-tools">
        <div className="sidebar-search">
          <span className="sidebar-search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            value={query}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search brainstorms…"
            spellCheck={false}
          />
          {rawQuery && (
            <button className="sidebar-search-clear" onClick={() => { setRawQuery(''); setQuery('') }} title="Clear">
              ×
            </button>
          )}
        </div>
        <button
          className="sidebar-sort"
          onClick={cycleSort}
          title="Change sort order"
        >
          ⇅ {SORT_LABELS[sort]}
        </button>
        <button
          className={`sidebar-scope${searchAll ? ' on' : ''}`}
          onClick={() => setSearchAll((v) => !v)}
          title={
            searchAll
              ? 'Searching all workspaces — click to limit to this one'
              : `Searching ${folderName} — click to search all workspaces`
          }
          aria-pressed={searchAll}
        >
          {searchAll ? 'All workspaces' : folderName}
        </button>
      </div>

      <div className="session-list">
        {sessions.length === 0 && (
          <div className="tree-empty">
            {query ? 'No brainstorms match your search.' : 'No brainstorms yet. Hit ＋ to start.'}
          </div>
        )}
        {sessions.map((s) => {
          // Only meaningful when results can come from other workspaces.
          const origin = searchAll ? folderNames[s.folderId] : undefined
          return (
            <div
              key={s.id}
              className={`session-row${s.id === activeSessionId ? ' active' : ''}${
                s.starred ? ' starred' : ''
              }`}
              onClick={() => {
                // Jump to the owning workspace so the editor and AI panel line up.
                if (s.folderId !== activeFolderId) useAppStore.getState().openFolder(s.folderId)
                selectSession(s.id)
              }}
              title={s.title}
            >
              <button
                className={`session-star${s.starred ? ' on' : ''}`}
                title={s.starred ? 'Unpin' : 'Pin to top'}
                aria-label={s.starred ? 'Unpin brainstorm' : 'Pin brainstorm to top'}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleStarSession(s.id)
                }}
              >
                {s.starred ? '★' : '☆'}
              </button>
              <div className="session-main">
                <div className="session-title">{s.title || 'Untitled brainstorm'}</div>
                <div className="session-meta">
                  {origin && <span className="session-origin">{origin}</span>}
                  {s.ideas.length} idea{s.ideas.length === 1 ? '' : 's'} · {s.messages.length} msg ·{' '}
                  {new Date(s.updatedAt).toLocaleDateString()}
                </div>
              </div>
              <button
                className="session-del"
                title="Delete brainstorm"
                aria-label="Delete brainstorm"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(`Delete "${s.title || 'Untitled brainstorm'}"?`)) deleteSession(s.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
