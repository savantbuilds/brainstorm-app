import { useState } from 'react'
import { findSession, useAppStore } from '../store/appStore'
import ChatView from './ChatView'
import NotesEditor from './NotesEditor'

type View = 'notes' | 'chat'

export default function CenterPane(): JSX.Element {
  const [view, setView] = useState<View>('notes')
  // Only the message count is needed for the tab label, so this doesn't
  // re-render on every character typed into the notes.
  const msgCount = useAppStore(
    (s) => findSession(s.sessions, s.activeSessionId)?.messages.length ?? 0
  )

  return (
    <div className="center-pane">
      <div className="center-tabs">
        <button
          className={`center-tab${view === 'notes' ? ' active' : ''}`}
          onClick={() => setView('notes')}
        >
          Notes
        </button>
        <button
          className={`center-tab${view === 'chat' ? ' active' : ''}`}
          onClick={() => setView('chat')}
        >
          Chat{msgCount > 0 ? ` (${msgCount})` : ''}
        </button>
      </div>
      <div className="center-body">{view === 'notes' ? <NotesEditor /> : <ChatView />}</div>
    </div>
  )
}
