import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import type { BackupEnvelope, StoreShape } from '@shared/types'

// Snapshot encryption.
//
// Backups contain whatever the user has typed into the app, so they are
// encrypted with a passphrase by default. The scheme is scrypt for key
// derivation and AES-256-GCM for the payload, which authenticates as well as
// encrypts — a tampered snapshot fails to decrypt rather than restoring garbage.
//
// Everything here runs in the main process; no passphrase or plaintext ever
// crosses into the renderer.

const KEY_LEN = 32 // AES-256
const IV_LEN = 12 // GCM standard nonce length
const SALT_LEN = 16

// scrypt cost parameters. N=2^15 with r=8 needs ~32 MB and roughly 100 ms per
// derivation on a typical machine: slow enough to make offline guessing of a
// weak passphrase expensive, fast enough for an interactive restore.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function deriveKey(passphrase: string, salt: Buffer, params = SCRYPT): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LEN, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem
  })
}

/** Wraps a payload in an envelope, encrypting it when a passphrase is given. */
export function sealSnapshot(
  data: StoreShape,
  opts: { appVersion: string; createdAt: number; passphrase?: string | null }
): BackupEnvelope {
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8')
  const { appVersion, createdAt, passphrase } = opts

  if (!passphrase) {
    return { format: 'brainstorm-backup', version: 1, createdAt, appVersion, data }
  }

  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const key = deriveKey(passphrase, salt)

  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const cipherText = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return {
    format: 'brainstorm-backup',
    version: 1,
    createdAt,
    appVersion,
    encryption: {
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p
    },
    cipherText: cipherText.toString('base64')
  }
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotError'
  }
}

/** Parses and, when necessary, decrypts an envelope. */
export function openSnapshot(envelope: BackupEnvelope, passphrase?: string | null): StoreShape {
  if (!envelope || envelope.format !== 'brainstorm-backup') {
    throw new SnapshotError('This file is not a Brainstorm backup.')
  }
  if (envelope.version !== 1) {
    throw new SnapshotError(`Unsupported backup version ${envelope.version}.`)
  }

  if (!envelope.encryption) {
    if (!envelope.data) throw new SnapshotError('Backup is missing its data.')
    return envelope.data
  }

  if (!passphrase) throw new SnapshotError('This backup is encrypted — a passphrase is required.')

  const enc = envelope.encryption
  if (enc.algorithm !== 'aes-256-gcm' || enc.kdf !== 'scrypt') {
    throw new SnapshotError('Backup uses an unknown encryption scheme.')
  }

  // scrypt cost is read from the file, so it is attacker-controlled input.
  // Cap it: a huge N would otherwise turn "restore" into an OOM.
  const N = Math.min(Number(enc.N) || SCRYPT.N, SCRYPT.N)
  const r = Math.min(Number(enc.r) || SCRYPT.r, SCRYPT.r)
  const p = Math.min(Number(enc.p) || SCRYPT.p, SCRYPT.p)

  const key = deriveKey(passphrase, Buffer.from(enc.salt, 'base64'), { N, r, p, maxmem: SCRYPT.maxmem })
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(enc.iv, 'base64')
  )
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'))

  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.cipherText ?? '', 'base64')),
      decipher.final()
    ])
  } catch {
    // GCM tag mismatch covers both a wrong passphrase and a modified file.
    // The message is deliberately the same for each, so it leaks nothing.
    throw new SnapshotError('Could not decrypt this backup. Check the passphrase.')
  }

  try {
    const parsed = JSON.parse(plaintext.toString('utf8'))
    if (!parsed || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.folders)) {
      throw new Error('shape')
    }
    return parsed as StoreShape
  } catch {
    throw new SnapshotError('Backup decrypted but did not contain valid data.')
  }
}

/** Constant-time compare, for passphrase confirmation fields. */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a.normalize('NFKC'))
  const bufB = Buffer.from(b.normalize('NFKC'))
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
