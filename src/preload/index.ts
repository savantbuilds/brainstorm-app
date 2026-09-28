import { contextBridge, ipcRenderer } from 'electron'
import type {
  BackupConfig,
  BackupEnvelope,
  BackupPreview,
  BackupRunResult,
  BackupSnapshotInfo,
  BackupStatus,
  ExposedApi,
  StoreShape
} from '@shared/types'

// Security bridge between the sandboxed renderer and the main process.
// Only these explicitly-listed capabilities are exposed to window.api.
const api: ExposedApi = {
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  exportFile: (defaultName, content) =>
    ipcRenderer.invoke('app:exportFile', defaultName, content) as Promise<boolean>,
  readFile: (extensions) => ipcRenderer.invoke('app:readFile', extensions) as Promise<BackupEnvelope | null>,
  getPreloadPath: (scriptName) => ipcRenderer.invoke('app:getPreloadPath', scriptName),

  storeGet: <K extends keyof StoreShape>(key: K) =>
    ipcRenderer.invoke('store:get', key) as Promise<StoreShape[K]>,
  storeSet: <K extends keyof StoreShape>(key: K, value: StoreShape[K]) =>
    ipcRenderer.invoke('store:set', key, value),

  // --- backup ---
  backupGetConfig: () => ipcRenderer.invoke('backup:getConfig') as Promise<BackupConfig>,
  backupSetConfig: (config) => ipcRenderer.invoke('backup:setConfig', config) as Promise<BackupConfig>,
  backupSetSecret: (password) => ipcRenderer.invoke('backup:setSecret', password) as Promise<boolean>,
  backupSecretPersisted: () => ipcRenderer.invoke('backup:secretPersisted') as Promise<boolean>,
  backupNow: () => ipcRenderer.invoke('backup:now') as Promise<BackupRunResult>,
  backupList: () => ipcRenderer.invoke('backup:list') as Promise<BackupSnapshotInfo[]>,
  backupInspect: (name, passphrase) =>
    ipcRenderer.invoke('backup:inspect', name, passphrase) as Promise<BackupPreview>,
  backupRestore: (name, passphrase, keepLocal) =>
    ipcRenderer.invoke('backup:restore', name, passphrase, keepLocal) as Promise<BackupRunResult>,
  backupTestConnection: () => ipcRenderer.invoke('backup:test') as Promise<{ ok: boolean; message: string }>,
  onBackupStatus: (cb) => {
    // Ask for the current value first, so a panel opened after a backup
    // finished still shows the correct state.
    void ipcRenderer.invoke('backup:status').then((s: BackupStatus) => cb(s))
    ipcRenderer.send('backup:subscribe')
    const listener = (_e: unknown, status: BackupStatus): void => cb(status)
    ipcRenderer.on('backup:status', listener)
    return () => ipcRenderer.removeListener('backup:status', listener)
  },

  onMenuAction: (cb) => {
    const listener = (_e: unknown, action: string): void => cb(action)
    ipcRenderer.on('menu:action', listener)
    // Returns a disposer. Callers MUST call it on unmount — without cleanup,
    // StrictMode's double-invoke and HMR remounts stack listeners, and a single
    // menu click then fires the handler once per accumulated listener.
    return () => ipcRenderer.removeListener('menu:action', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
