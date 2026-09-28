import { join } from 'node:path'
import { BrowserWindow, Menu, shell } from 'electron'

const CHATGPT_ORIGIN = 'https://chatgpt.com'
const CHATGPT_ALLOWED = ['https://chatgpt.com', 'https://auth.openai.com', 'https://cdn.oaistatic.com']

export function createWindow(): BrowserWindow {
  const iconPath = join(__dirname, '../../resources/icon.ico')
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    title: 'Brainstorm',
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Required so the renderer can host the <webview> AI panel.
      webviewTag: true
    }
  })

  // Keep the main renderer locked to our own app: never let app chrome navigate
  // away. (The <webview> is a separate, sandboxed guest — its navigation is
  // constrained in app.on('web-contents-created') below.)
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://localhost')) {
      e.preventDefault()
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  buildAppMenu(win)
  return win
}

// Constrain the embedded ChatGPT guest webview: it may only stay within
// OpenAI's own auth/app origins. Anything else opens in the system browser.
export function guardWebview(contents: Electron.WebContents): void {
  contents.on('will-navigate', (e, url) => {
    if (!CHATGPT_ALLOWED.some((o) => url.startsWith(o))) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

export { CHATGPT_ORIGIN }

function buildAppMenu(win: BrowserWindow): void {
  const send = (action: string) => () => win.webContents.send('menu:action', action)
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Session',
      submenu: [
        { label: 'New Brainstorm', accelerator: 'CmdOrCtrl+N', click: send('new-session') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: send('command-palette')
        },
        { type: 'separator' },
        {
          label: 'Toggle AI Panel',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: send('toggle-ai')
        },
        {
          label: 'Focus Mode',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: send('focus-mode')
        },
        {
          label: 'Toggle Light / Dark Theme',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: send('toggle-theme')
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Brainstorm',
      submenu: [
        { label: 'New Brainstorm', accelerator: 'CmdOrCtrl+N', click: send('new-session') },
        { type: 'separator' },
        {
          label: 'Workspaces…',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: send('open-workspaces')
        },
        { type: 'separator' },
        { label: 'Cloud Backup…', accelerator: 'CmdOrCtrl+Shift+B', click: send('open-backup') },
        { label: 'Back Up Now', click: send('backup-now') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
