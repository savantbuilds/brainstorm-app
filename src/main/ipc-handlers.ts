import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import type { BackupConfig, BackupEnvelope, StoreShape } from '@shared/types'
import { getKey, setKey } from './storage'
import {
  getBackupConfig,
  getBackupStatus,
  inspectSnapshot,
  listSnapshots,
  onBackupStatus,
  restoreSnapshot,
  runBackup,
  secretPersisted,
  setBackupConfig,
  setSessionPassphrase,
  setWebdavSecret,
  testConnection
} from './backup/service'

export function registerIpcHandlers(): void {
  ipcMain.handle('clipboard:write', async (_e, text: string) => {
    clipboard.writeText(text)
  })

  // Save arbitrary text to a user-chosen file (used for Markdown export).
  ipcMain.handle('app:exportFile', async (e, defaultName: string, content: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return false
    await writeFile(filePath, content, 'utf8')
    return true
  })

  // Open a backup file from disk. The payload is validated before it reaches
  // the renderer, so a malformed or hostile file can't be treated as data.
  ipcMain.handle('app:readFile', async (e, extensions?: string[]) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Brainstorm backup', extensions: extensions?.length ? extensions : ['brainstorm', 'json'] }]
    })
    if (canceled || !filePaths[0]) return null
    try {
      const raw = await readFile(filePaths[0], 'utf8')
      const parsed = JSON.parse(raw) as BackupEnvelope
      if (parsed?.format !== 'brainstorm-backup') return null
      return parsed
    } catch {
      return null
    }
  })

  ipcMain.handle('store:get', async (_e, key: keyof StoreShape) => getKey(key))
  ipcMain.handle('store:set', async (_e, key: keyof StoreShape, value: StoreShape[keyof StoreShape]) => {
    setKey(key, value as never)
  })

  ipcMain.handle('app:getPreloadPath', async (_e, scriptName: string) => {
    const path = join(__dirname, '../preload', scriptName)
    const { pathToFileURL } = await import('node:url')
    return pathToFileURL(path).href
  })

  // --- backup -------------------------------------------------------------
  ipcMain.handle('backup:getConfig', () => getBackupConfig())
  ipcMain.handle('backup:setConfig', (_e, config: BackupConfig) => setBackupConfig(config))

  ipcMain.handle('backup:setSecret', (_e, password: string | null) => {
    if (password === null) {
      setSessionPassphrase(null)
      return setWebdavSecret(null)
    }
    // One field serves both roles: the UI labels it per target, and for a
    // folder target it is the snapshot encryption passphrase.
    setSessionPassphrase(password)
    return setWebdavSecret(getBackupConfig().target === 'webdav' ? password : null)
  })

  ipcMain.handle('backup:secretPersisted', () => secretPersisted())
  ipcMain.handle('backup:now', () => runBackup())
  ipcMain.handle('backup:list', () => listSnapshots())
  ipcMain.handle('backup:inspect', (_e, name: string, passphrase?: string) =>
    inspectSnapshot(name, passphrase ?? null)
  )
  ipcMain.handle(
    'backup:restore',
    (_e, name: string, passphrase: string | null, keepLocal: boolean) =>
      restoreSnapshot(name, passphrase, keepLocal)
  )
  ipcMain.handle('backup:test', () => testConnection())

  // Status changes are pushed to every open window, so a backup started from
  // the menu shows up in the panel without polling.
  ipcMain.on('backup:subscribe', (e) => {
    e.sender.send('backup:status', getBackupStatus())
  })
  ipcMain.handle('backup:status', () => getBackupStatus())
  onBackupStatus(() => {
    const status = getBackupStatus()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('backup:status', status)
    }
  })
}

