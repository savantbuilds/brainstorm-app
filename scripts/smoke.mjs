/**
 * Headless smoke test.
 *
 * Boots the real main process against the real preload, renders the real
 * renderer bundle, and fails on any renderer error or failed load. Then it
 * drives the actual user journey — create a workspace, start a brainstorm, type
 * in the notes, open the command palette, toggle focus mode — so a regression
 * surfaces as a non-zero exit rather than a blank window.
 *
 * Run with: npm run smoke
 */
import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Store from 'electron-store'

// ESM has no __dirname; resolve it once and build the out/ paths from it.
const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'out')

// Redirect the profile before anything reads it, so the run can't touch the
// developer's real data.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'brainstorm-smoke-')))
app.setPath('sessionData', app.getPath('userData'))

// A real store, so hydration and the debounced autosave are actually covered.
const store = new Store({
  name: 'brainstorm-smoke',
  defaults: { folders: [], sessions: [], settings: {} }
})

const failures = []

function fail(where, detail) {
  const message = detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : String(detail)
  failures.push(`[${where}] ${message}`)
  console.error(`SMOKE FAILURE (${where}):`, message)
}

app.on('window-all-closed', () => {})

// The renderer reaches the main process over these channels. Clipboard and the
// save dialog are stubbed (they'd pop UI), but the store handlers are the real
// ones, so hydration and autosave are genuinely exercised.
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(text)
})
ipcMain.handle('app:exportFile', async () => false)
ipcMain.handle('app:getPreloadPath', async (_e, scriptName) =>
  pathToFileURL(join(out, 'preload', scriptName)).href
)
ipcMain.handle('store:get', async (_e, key) => store.get(key))
ipcMain.handle('store:set', async (_e, key, value) => {
  store.set(key, value)
})

// Runs inside the renderer. Uses the native value setter so React's controlled
// inputs actually pick the change up, then dispatches the input event.
const JOURNEY = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!window.api) throw new Error('window.api missing - preload did not run');

  const app = document.querySelector('.app');
  if (!app) throw new Error('.app did not render');
  if (!app.dataset.accent) throw new Error('accent token attribute missing');
  if (!app.className.includes('theme-')) throw new Error('theme class missing');

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }));
  await wait(150);
  if (document.querySelectorAll('.palette-item').length === 0) throw new Error('command palette produced no items');
  document.querySelector('.palette-overlay')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(150);

  const modal = document.querySelector('.folder-modal');
  if (!modal) throw new Error('folder modal did not open on first run');

  const input = document.querySelector('.folder-newinput');
  if (!input) throw new Error('folder name input missing');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Smoke Workspace');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(80);
  document.querySelector('.folder-newrow .btn-primary').click();
  await wait(300);

  // A workspace on its own has no brainstorms; start one via the palette.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }));
  await wait(150);
  const newCmd = [...document.querySelectorAll('.palette-item')].find((el) => el.textContent.includes('Brainstorm: New'));
  if (!newCmd) throw new Error('new-brainstorm command missing from palette');
  newCmd.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(350);

  const rows = document.querySelectorAll('.session-row');
  if (rows.length !== 1) throw new Error('expected exactly one brainstorm, got ' + rows.length);
  rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(250);

  const ta = document.querySelector('.notes-body');
  if (!ta) throw new Error('notes editor did not render');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '# Smoke' + String.fromCharCode(10) + String.fromCharCode(10) + '- one' + String.fromCharCode(10) + '- two');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(250);

  if (!document.querySelector('.notes-title')) throw new Error('notes title input missing');

  const meta = document.querySelector('.notes-meta');
  if (!meta || !/[0-9]+ words?/.test(meta.textContent)) {
    throw new Error('word count did not update: ' + (meta && meta.textContent));
  }

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
  await wait(200);
  if (!document.querySelector('.app').className.includes('focus-mode')) throw new Error('focus mode did not engage');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
  await wait(200);

  const tabs = document.querySelectorAll('.center-tab');
  tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(150);
  tabs[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(150);

  // The font size setting is stored and applied to the notes surface.
  const before = getComputedStyle(document.querySelector('.notes-body')).fontSize;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }));
  await wait(150);
  const sizeCmd = [...document.querySelectorAll('.palette-item')].find((el) => el.textContent.includes('Font size 18px'));
  if (!sizeCmd) throw new Error('font size command missing from palette');
  sizeCmd.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(250);
  const after = getComputedStyle(document.querySelector('.notes-body')).fontSize;
  if (parseFloat(after) <= parseFloat(before)) {
    throw new Error('font size did not apply: ' + before + ' -> ' + after);
  }

  return 'ok';
})()`

async function run() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: join(out, 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })

  const wc = win.webContents
  wc.on('console-message', (_e, level, message) => {
    // 3 === error. Third-party noise from the embedded page is not ours.
    if (level >= 3 && !/Autofill|devtools|Download the React/i.test(message)) fail('console', message)
  })
  wc.on('render-process-gone', (_e, details) => fail('renderer-gone', details.reason))
  wc.on('preload-error', (_e, preloadPath, error) => fail(`preload:${preloadPath}`, error))
  wc.on('did-fail-load', (_e, code, desc, url) => fail(`load:${url}`, `${code} ${desc}`))

  await wc.loadFile(join(out, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 600))

  const result = await wc.executeJavaScript(JOURNEY)
  if (result !== 'ok') fail('journey', `script returned ${String(result)}`)

  // Autosave is debounced, so give it room to land before reading it back.
  // This is the assertion that catches a regression in the persistence layer:
  // the work done above must survive a restart.
  await new Promise((r) => setTimeout(r, 900))

  const saved = store.get('sessions')
  const savedFolders = store.get('folders')
  if (savedFolders.length !== 1) {
    fail('persistence', `expected 1 workspace on disk, got ${savedFolders.length}`)
  }
  if (saved.length !== 1) {
    fail('persistence', `expected 1 brainstorm on disk, got ${saved.length}`)
  } else {
    const s = saved[0]
    if (s.folderId !== savedFolders[0].id) {
      fail('persistence', `brainstorm folderId ${s.folderId} does not match workspace ${savedFolders[0].id}`)
    }
    if (!s.notes.includes('- one')) {
      fail('persistence', `notes were not autosaved: ${JSON.stringify(s.notes)}`)
    }
  }
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (err) {
    fail('run', err)
  }

  if (failures.length > 0) {
    console.error(`\nSmoke test FAILED with ${failures.length} problem(s):`)
    for (const f of failures) console.error(' -', f)
    app.exit(1)
    return
  }

  console.log('Smoke test passed: renderer boots and the core journey runs clean.')
  app.exit(0)
})

// Hard stop, so a wedged renderer can never hang the run.
setTimeout(() => {
  fail('timeout', 'smoke test exceeded 90s')
  app.exit(1)
}, 90_000)
