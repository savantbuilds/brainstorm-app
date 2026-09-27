import Store from 'electron-store'
import type { StoreShape } from '@shared/types'

// Local persistence layer. Holds work folders, brainstorm sessions and settings.
// The renderer owns all mutation (via its zustand store) and writes back through
// the store:* IPC channels, so the main side is read-through only.

const store = new Store<StoreShape>({
  name: 'brainstorm-app',
  defaults: {
    folders: [],
    sessions: [],
    settings: {
      theme: 'dark',
      fontSize: 14,
      aiPanelWidth: 420,
      sidebarWidth: 260
    }
  }
})

export function getKey<K extends keyof StoreShape>(key: K): StoreShape[K] {
  return store.get(key)
}

export function setKey<K extends keyof StoreShape>(key: K, value: StoreShape[K]): void {
  store.set(key, value)
}
