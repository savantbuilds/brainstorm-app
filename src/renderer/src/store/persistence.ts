import { useEffect, useRef, useState } from 'react'
import type { BrainstormSession, WorkFolder } from '@shared/types'
import { useAppStore } from './appStore'

// Trailing-edge debounce with an explicit flush. Autosave is the only writer of
// the on-disk store, so coalescing here means a burst of edits (typing a
// paragraph, dragging a pane) costs one write instead of one per mutation.
function debounce(fn: () => void, ms: number): Debounced {
  let timer: number | undefined
  const wrapped = (): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      fn()
    }, ms)
  }
  wrapped.flush = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
      fn()
    }
  }
  return wrapped
}

type Debounced = ((...args: unknown[]) => void) & { flush: () => void }
type Slice = 'sessions' | 'folders' | 'settings'

/**
 * Owns the renderer's whole relationship with the on-disk store: the initial
 * load, and the debounced write-behind that keeps it in sync afterwards.
 *
 * The three slices are debounced separately because they change at wildly
 * different rates — settings on a theme flip, folders on a rename, and sessions
 * on literally every keystroke in the notes editor.
 */
export function usePersistence(): { loaded: boolean; flush: () => void } {
  const [loaded, setLoaded] = useState(false)
  const flushRef = useRef<() => void>(() => {})

  // Initial load, plus migration of sessions orphaned by the workspaces feature.
  useEffect(() => {
    let cancelled = false

    Promise.all([
      window.api.storeGet('settings'),
      window.api.storeGet('folders'),
      window.api.storeGet('sessions')
    ]).then(([settings, folders, sessions]) => {
      if (cancelled) return

      if (settings) useAppStore.getState().setSettings(settings)

      let folderList: WorkFolder[] = folders ?? []
      let sessionList: BrainstormSession[] = sessions ?? []

      // Sessions written before workspaces existed have no folderId, and a
      // folder can be deleted out from under its sessions. Adopt every orphan
      // into a fallback folder so nothing is ever stranded.
      const known = new Set(folderList.map((f) => f.id))
      const isOrphan = (s: BrainstormSession): boolean => !s.folderId || !known.has(s.folderId)
      if (sessionList.some(isOrphan)) {
        let fallback = folderList[0]
        if (!fallback) {
          fallback = { id: `folder_${Date.now()}`, name: 'My Workspace', createdAt: Date.now() }
          folderList = [fallback]
        }
        const target = fallback.id
        sessionList = sessionList.map((s) => (isOrphan(s) ? { ...s, folderId: target } : s))
      }

      useAppStore.getState().setFolders(folderList)
      useAppStore.getState().setSessions(sessionList)
      useAppStore.setState({ hydrated: true })
      setLoaded(true)
    })

    return () => {
      cancelled = true
    }
  }, [])

  // Write-behind. Not armed until the load resolves, otherwise the first
  // setFolders/setSessions would immediately re-write what we just read.
  useEffect(() => {
    if (!loaded) return

    // Honour the autosave opt-out for session writes; settings and folders are
    // still written, so turning it back on restores everything.
    const persist = (key: Slice): void => {
      const state = useAppStore.getState()
      if (key === 'sessions' && state.settings.autosave === false) return
      void window.api.storeSet(key, state[key])
    }

    const timers: Record<Slice, Debounced> = {
      sessions: debounce(() => persist('sessions'), 400),
      folders: debounce(() => persist('folders'), 200),
      settings: debounce(() => persist('settings'), 200)
    }

    flushRef.current = (): void => {
      timers.sessions.flush()
      timers.folders.flush()
      timers.settings.flush()
    }

    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.sessions !== prev.sessions) timers.sessions()
      if (state.folders !== prev.folders) timers.folders()
      if (state.settings !== prev.settings) timers.settings()
    })

    // Tearing down mid-debounce (window close, HMR) would otherwise drop the
    // final edit, so always flush what is still pending.
    const flush = (): void => flushRef.current()
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', flush)

    return () => {
      unsub()
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', flush)
      flushRef.current()
    }
  }, [loaded])

  return { loaded, flush: () => flushRef.current() }
}