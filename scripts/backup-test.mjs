/**
 * Backup unit tests.
 *
 * Runs under Electron, against the real compiled backup modules (emitted as
 * out/main/backup-under-test.js), so the crypto and transport code under test is
 * exactly the code that ships. Covers the security-critical behaviour: the
 * encrypt/decrypt round trip, tamper and wrong-passphrase rejection, and the
 * folder target's write/list/read behaviour.
 *
 * Run with: npm run test:backup
 */
import { app } from 'electron'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(
  pathToFileURL(join(here, '..', 'out', 'main', 'backup-under-test.js')).href
)
const { openSnapshot, sealSnapshot, SnapshotError, FolderTarget, createTarget } = mod

// Keep the test off the developer's real profile and real store file.
const scratch = mkdtempSync(join(tmpdir(), 'brainstorm-backup-test-'))
app.setPath('userData', join(scratch, 'userdata'))
app.setPath('sessionData', join(scratch, 'sessiondata'))

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed++
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function assertThrows(fn, match) {
  try {
    fn()
  } catch (err) {
    assert(
      err instanceof Error && err.message.includes(match),
      `expected error containing "${match}", got "${err.message}"`
    )
    return
  }
  throw new Error(`expected a throw containing "${match}"`)
}

const SAMPLE = {
  folders: [{ id: 'f1', name: 'Work', createdAt: 1 }],
  sessions: [
    {
      id: 's1',
      folderId: 'f1',
      title: 'Launch ideas',
      notes: '# Heading\n\nSome notes with unicode: café ☕',
      ideas: [{ id: 'i1', text: 'An idea', source: 'ai', createdAt: 2 }],
      messages: [{ role: 'user', content: 'hello', timestamp: 3 }],
      createdAt: 1,
      updatedAt: 5
    }
  ],
  settings: { theme: 'dark', fontSize: 14, aiPanelWidth: 420, sidebarWidth: 260 }
}

const meta = { appVersion: '1.0.0', createdAt: 1_700_000_000_000 }

// --- crypto ----------------------------------------------------------------

check('plain round trip preserves the payload', () => {
  const env = sealSnapshot(SAMPLE, { ...meta, passphrase: null })
  assert(env.data, 'unencrypted envelope should carry data inline')
  assert(!env.cipherText, 'unencrypted envelope should have no ciphertext')
  assert(JSON.stringify(openSnapshot(env)) === JSON.stringify(SAMPLE), 'payload changed')
})

check('encrypted round trip preserves the payload', () => {
  const env = sealSnapshot(SAMPLE, { ...meta, passphrase: 'correct horse battery staple' })
  assert(!env.data, 'encrypted envelope must not leak plaintext')
  assert(!!env.cipherText, 'encrypted envelope should carry ciphertext')
  assert(env.encryption?.algorithm === 'aes-256-gcm', 'wrong algorithm')
  const out = openSnapshot(env, 'correct horse battery staple')
  assert(JSON.stringify(out) === JSON.stringify(SAMPLE), 'payload changed through encryption')
})

check('the passphrase and note text do not leak into the file', () => {
  const env = sealSnapshot(SAMPLE, { ...meta, passphrase: 'hunter2' })
  const blob = JSON.stringify(env)
  assert(!blob.includes('hunter2'), 'passphrase leaked into the file')
  assert(!blob.includes('Launch ideas'), 'note title leaked into the file')
  assert(!blob.includes('café'), 'note content leaked into the file')
})

check('each snapshot uses a fresh salt and iv', () => {
  const a = sealSnapshot(SAMPLE, { ...meta, passphrase: 'pw' })
  const b = sealSnapshot(SAMPLE, { ...meta, passphrase: 'pw' })
  assert(a.encryption.salt !== b.encryption.salt, 'salt reused')
  assert(a.encryption.iv !== b.encryption.iv, 'iv reused')
  assert(a.cipherText !== b.cipherText, 'ciphertext identical for identical plaintext')
})

check('a wrong passphrase is rejected', () => {
  const env = sealSnapshot(SAMPLE, { ...meta, passphrase: 'right' })
  assertThrows(() => openSnapshot(env, 'wrong'), 'Check the passphrase')
})

check('a missing passphrase is rejected with a clear message', () => {
  const env = sealSnapshot(SAMPLE, { ...meta, passphrase: 'right' })
  assertThrows(() => openSnapshot(env, null), 'passphrase is required')
})

check('a tampered ciphertext is rejected', () => {
  const env = sealSnapshot(SAMPLE, { ...meta, passphrase: 'pw' })
  const bytes = Buffer.from(env.cipherText, 'base64')
  bytes[0] ^= 0xff
  assertThrows(
    () => openSnapshot({ ...env, cipherText: bytes.toString('base64') }, 'pw'),
    'Check the passphrase'
  )
})

check('a tampered auth tag is rejected', () => {
  const env = sealSnapshot(SAMPLE, { ...meta, passphrase: 'pw' })
  const tag = Buffer.from(env.encryption.authTag, 'base64')
  tag[0] ^= 0xff
  assertThrows(
    () => openSnapshot({ ...env, encryption: { ...env.encryption, authTag: tag.toString('base64') } }, 'pw'),
    'Check the passphrase'
  )
})

check('a non-brainstorm file is rejected', () => {
  assertThrows(() => openSnapshot({ format: 'something-else' }), 'not a Brainstorm backup')
})

check('a future version is rejected rather than misread', () => {
  const env = sealSnapshot(SAMPLE, { ...meta, passphrase: null })
  assertThrows(() => openSnapshot({ ...env, version: 2 }), 'Unsupported backup version')
})

check('a hostile scrypt cost cannot exhaust memory', () => {
  const env = sealSnapshot(SAMPLE, { ...meta, passphrase: 'pw' })
  const hostile = { ...env, encryption: { ...env.encryption, N: 1 << 30, r: 1024, p: 16 } }
  // It must either fail cleanly or succeed - it must not hang or OOM.
  try {
    openSnapshot(hostile, 'pw')
  } catch (err) {
    assert(err instanceof SnapshotError, 'hostile params should surface as a SnapshotError')
  }
})

check('a unicode passphrase works regardless of normalisation form', () => {
  // The same passphrase typed as NFC vs NFD must open the same snapshot.
  const env = sealSnapshot(SAMPLE, { ...meta, passphrase: 'pásswörd' })
  const out = openSnapshot(env, 'pásswörd'.normalize('NFD'))
  assert(out.sessions.length === 1, 'normalised passphrase failed')
})

// --- folder target ---------------------------------------------------------
//
// These are async (the transports are), so they run after the sync crypto
// checks, once the app is ready.

const dir = join(scratch, 'vault')

const asyncChecks = [
  async function probeCreatesTheDirectoryWithoutWritingSnapshots() {
    const target = new FolderTarget(join(dir, 'made', 'on', 'demand'))
    await target.probe()
    assert(readdirSync(join(scratch, 'vault', 'made', 'on', 'demand')).length === 0, 'probe should not write files')
  },
  async function roundTripsThroughTheFolderTarget() {
    const target = new FolderTarget(dir)
    const env = sealSnapshot(SAMPLE, { ...meta, passphrase: 'pw' })
    const name = mod.makeSnapshotName(meta.createdAt)
    await target.write(name, JSON.stringify(env))
    const raw = await target.read(name)
    const back = openSnapshot(JSON.parse(raw), 'pw')
    assert(back.sessions[0].title === 'Launch ideas', 'round trip lost the title')

    const listed = await target.list()
    assert(listed.length === 1, `expected 1 snapshot, got ${listed.length}`)
    assert(listed[0].encrypted === true, 'snapshot should report as encrypted')
    assert(listed[0].createdAt === meta.createdAt, 'createdAt not read back')
  },
  async function listingIgnoresForeignFiles() {
    const target = new FolderTarget(dir)
    writeFileSync(join(dir, 'notes.txt'), 'user data we must not touch')
    writeFileSync(join(dir, 'other.json'), '{}')
    const listed = await target.list()
    assert(listed.every((s) => s.name.endsWith(mod.SNAPSHOT_EXT)), 'listing included a foreign file')
    assert(readdirSync(dir).includes('notes.txt'), 'a foreign file was deleted')
  },
  async function rejectsSnapshotNamesThatEscapeTheDirectory() {
    const target = new FolderTarget(dir)
    for (const evil of ['../../escape.brainstorm', '/etc/passwd', 'backup-x.brainstorm/../y']) {
      let threw = false
      try {
        await target.write(evil, 'x')
      } catch {
        threw = true
      }
      assert(threw, `writing "${evil}" should have been rejected`)
    }
  },
  async function listsSnapshotsNewestFirst() {
    const target = new FolderTarget(dir)
    const names = [1000, 2000, 3000].map((t) => mod.makeSnapshotName(meta.createdAt + t))
    for (const n of names) await target.write(n, JSON.stringify(sealSnapshot(SAMPLE, meta)))
    const listed = await target.list()
    assert(listed.length === 4, `expected 4 snapshots, got ${listed.length}`)
    for (let i = 1; i < listed.length; i++) {
      assert(listed[i - 1].createdAt >= listed[i].createdAt, 'listing is not newest-first')
    }
  },
  async function rejectsUnusableWebdavUrls() {
    let threw = ''
    try {
      createTarget({ target: 'webdav', location: 'not a url', encrypt: true, enabled: true, intervalMinutes: 0, keepSnapshots: 1 }, null)
    } catch (err) {
      threw = err.message
    }
    assert(threw.includes('valid URL'), `expected a URL error, got "${threw}"`)

    threw = ''
    try {
      createTarget({ target: 'webdav', location: 'ftp://host/dav', encrypt: true, enabled: true, intervalMinutes: 0, keepSnapshots: 1 }, null)
    } catch (err) {
      threw = err.message
    }
    assert(threw.includes('http'), `expected a protocol error, got "${threw}"`)
  },
  async function rejectsAnUnconfiguredFolder() {
    let threw = ''
    try {
      createTarget({ target: 'folder', location: '   ', encrypt: true, enabled: true, intervalMinutes: 0, keepSnapshots: 1 }, null)
    } catch (err) {
      threw = err.message
    }
    assert(threw.includes('backup folder'), `expected a folder error, got "${threw}"`)
  }
]

app.whenReady().then(async () => {
  for (const fn of asyncChecks) {
    const name = fn.name || 'async check'
    try {
      await fn()
      passed++
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // A leftover temp dir is harmless.
  }

  if (failures.length > 0) {
    console.error(`\nBackup tests FAILED (${failures.length} of ${passed + failures.length}):`)
    for (const f of failures) console.error(' -', f)
    app.exit(1)
    return
  }
  console.log(`Backup tests passed: ${passed} checks.`)
  app.exit(0)
})

setTimeout(() => {
  console.error('Backup tests timed out after 60s')
  app.exit(1)
}, 60_000)

