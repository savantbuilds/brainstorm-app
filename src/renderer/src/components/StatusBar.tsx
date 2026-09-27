import { findSession, selectTotals, useAppStore } from '../store/appStore'

export default function StatusBar(): JSX.Element {
  // Totals and the active word count are read through narrow selectors, so
  // editing the notes doesn't re-render this bar on every keystroke.
  const totals = useAppStore(selectTotals)
  const words = useAppStore((s) => {
    const notes = findSession(s.sessions, s.activeSessionId)?.notes ?? ''
    return notes.trim() ? notes.trim().split(/\s+/).length : 0
  })
  const hasActive = useAppStore((s) => !!findSession(s.sessions, s.activeSessionId))

  return (
    <div className="statusbar">
      <span>
        {totals.sessions} brainstorm{totals.sessions === 1 ? '' : 's'}
      </span>
      <span className="spacer" />
      {hasActive && (
        <>
          <span>
            {totals.ideas} idea{totals.ideas === 1 ? '' : 's'}
          </span>
          <span>{words} words</span>
        </>
      )}
      <span className="statusbar-hint">Ctrl+Shift+P · commands</span>
    </div>
  )
}
