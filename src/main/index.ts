import { app, BrowserWindow, session } from 'electron'
import { registerIpcHandlers } from './ipc-handlers'
import { createWindow, guardWebview } from './window'
import { disposeBackup, initBackup } from './backup/service'

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.yourname.brainstorm-app')
  }

  // Loads the backup config and arms the automatic-backup timer. Runs before
  // the window is created so the first paint already reflects the setting.
  initBackup()

  registerIpcHandlers()

  // Apply navigation guards to any <webview> guest as it is created.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') {
      guardWebview(contents)
    }
  })

  // Give the embedded ChatGPT guest a realistic UA so the site serves the
  // normal web app rather than an "unsupported browser" page.
  const guestSession = session.fromPartition('persist:chatgpt-guest')
  guestSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Stop the backup timer and drop its listeners; without this a pending
  // automatic backup can keep the process alive after the last window closes.
  disposeBackup()
  if (process.platform !== 'darwin') app.quit()
})
