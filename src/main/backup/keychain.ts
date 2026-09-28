import { app, safeStorage } from 'electron'
import Store from 'electron-store'

// A minimal credential store built on Electron 31's safeStorage.
//
// Electron 34 added safeStorage.get/setPassword; on 31 the primitives are
// encryptString/decryptString, so the ciphertext is kept in its own small
// electron-store file. It is still protected by the OS keychain (DPAPI on
// Windows, Keychain on macOS, libsecret on Linux) — the file itself is only
// readable ciphertext, and never leaves the user profile.

const KEY = 'secret'

let vault: Store<Record<string, string>> | null = null

function store(): Store<Record<string, string>> | null {
  try {
    if (!app.isReady()) return null
    if (!vault) vault = new Store<Record<string, string>>({ name: 'brainstorm-secrets' })
    return vault
  } catch {
    return null
  }
}

/** True when the OS offers usable encryption (i.e. a keychain is unlocked). */
export function isAvailable(): boolean {
  try {
    return app.isReady() && safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function setSecret(value: string | null): boolean {
  const s = store()
  if (!s || !isAvailable()) return false
  try {
    if (value === null || value === '') {
      s.delete(KEY)
    } else {
      s.set(KEY, safeStorage.encryptString(value).toString('base64'))
    }
    return true
  } catch {
    return false
  }
}

export function getSecret(): string | null {
  const s = store()
  if (!s || !isAvailable()) return null
  try {
    const blob = s.get(KEY)
    if (typeof blob !== 'string' || !blob) return null
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    // A blob that can't be decrypted means the OS key changed, or the user
    // revoked access. Treat it as "no stored secret" rather than crashing.
    return null
  }
}
