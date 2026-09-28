# Brainstorm

An Electron desktop app for brainstorming with an embedded ChatGPT panel and a notes/outline surface. Write ideas, capture AI responses, and organize your thoughts in workspaces.

## Features

- **Cloud backup** — encrypted snapshots to a synced folder (Dropbox, OneDrive, Google Drive) or a WebDAV server (Nextcloud, ownCloud, a NAS), on a schedule or on demand
- **Restore with a safety net** — merge two machines' work or replace wholesale, always with the current state snapshotted first
- **Embedded ChatGPT panel** — brainstorm, expand, critique, or ask freeform questions without leaving the app
- **Per-brainstorm conversations** — each brainstorm keeps its own ChatGPT thread, and the most recent few stay warm so switching is instant
- **Rich notes editor** — write and organize your ideas in a markdown-friendly surface
- **Workspaces** — group brainstorming sessions into folders, with search across all of them
- **Quick actions** — one-click Brainstorm, Expand, Critique, and Send Notes buttons
- **Context menu** — highlight text in notes to critique or expand a selection
- **Captured ideas** — save AI responses as persistent ideas, and promote any idea straight into your notes
- **Consolidation** — merge scattered notes into a structured outline with AI help
- **Conversation recovery** — re-inject a saved transcript into a fresh chat, chunked automatically when it's long
- **Focus mode** — collapse the sidebar and AI panel down to just the notes
- **Command palette** — fuzzy search over commands and brainstorms (Ctrl+Shift+P)
- **Resizable panes** — drag to resize the sidebar and AI panel, or double-click a divider for focus mode
- **Dark / Light themes** — with five accent colours, all driven by a shared token layer
- **Automatic saving** — debounced write-behind, flushed on close so no edit is ever lost
- **Cross-platform** — builds for macOS, Windows, and Linux

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- npm or pnpm

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

### Type Check

```bash
npm run typecheck
```

### Smoke Test

```bash
npm run smoke
```

Builds the app, boots it headlessly against a throwaway profile, and drives the
core journey — create a workspace, start a brainstorm, write notes, open the
palette, toggle focus mode — asserting that the data is actually persisted. Fails
on any renderer, preload, or load error.

### Backup Tests

```bash
npm run test:backup
```

Exercises the backup subsystem directly: encrypt/decrypt round trips, wrong
passphrases, tampered ciphertext and auth tags, plaintext leakage, path
traversal in snapshot names, and target validation.

### Cloud Backup

Open it from the toolbar menu, the command palette, or `Ctrl+Shift+B`.

Two destinations are supported, and neither needs an account with us:

- **Synced folder** — any directory on this machine. If it's inside Dropbox,
  OneDrive or Google Drive, snapshots reach the cloud through the client you
  already run.
- **WebDAV server** — a Nextcloud, ownCloud, or NAS endpoint over `http(s)`,
  authenticated with HTTP Basic.

Snapshots are encrypted with AES-256-GCM by default, keyed by scrypt from a
passphrase you choose. **There is no recovery for a lost passphrase** — the
data is unrecoverable without it, by design.

The WebDAV password and the encryption passphrase are held in the OS keychain
(via Electron's `safeStorage`) and never written to the settings file. On a
system with no keyring daemon the panel says so, and the secret is kept for the
session only.

Restoring always takes a snapshot of your current data first, so a restore you
didn't want is itself reversible from the snapshot list.

### Debugging the ChatGPT bridge

The guest preload is quiet by default. To trace its selector lookups and
injection steps, set `localStorage.brainstormDebug = '1'` in the embedded page's
devtools.

### Build

```bash
# Package for your platform
npm run dist          # all platforms
npm run dist:mac      # macOS
npm run dist:win      # Windows
npm run dist:linux    # Linux
```

## Tech Stack

- **Electron 31** with [electron-vite](https://electron-vite.org/)
- **React 18** (TypeScript)
- **Zustand** for state management
- **electron-store** for persistence
- **react-markdown** + remark-gfm for rendering captured AI responses

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+N | New brainstorm |
| Ctrl+Shift+P | Command palette |
| Ctrl+Shift+A | Toggle the AI panel |
| Ctrl+Shift+F | Focus mode |
| Ctrl+Shift+L | Toggle light / dark theme |
| Ctrl+Shift+W | Workspaces |
| Ctrl+Shift+B | Back up now |
| Ctrl+E | Export the current brainstorm as Markdown |
| Enter (in AI composer) | Send prompt to ChatGPT |
| Shift+Enter (in AI composer) | New line in prompt |

## Project Structure

```
src/
  main/           Electron main process (window, IPC, store)
  preload/        Context bridge & ChatGPT webview injection
  renderer/       React UI (components, store, styles)
  shared/         Types shared between main and renderer
scripts/
  smoke.mjs       Headless end-to-end smoke test
resources/        App icons
```

## License

MIT
