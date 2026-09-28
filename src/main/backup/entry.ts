// A side-effect-free entry point for the backup subsystem.
//
// The main bundle already contains all of this; this file exists so the test
// suite can import the real, compiled modules (with the same alias resolution
// and Electron runtime the app uses) rather than a hand-copied reimplementation
// that could drift from what actually ships.

export { openSnapshot, sealSnapshot, SnapshotError } from './crypto'
export {
  createTarget,
  describeSnapshot,
  FolderTarget,
  makeSnapshotName,
  SNAPSHOT_EXT,
  WebdavTarget
} from './target'
// storage.ts is re-exported so the tests can drive the service through the same
// store instance it uses, rather than a second electron-store on the same file
// whose in-memory copy would drift.
export { getKey, setKey } from '../storage'
export {
  getBackupConfig,
  initBackup,
  inspectSnapshot,
  listSnapshots,
  onBackupStatus,
  restoreSnapshot,
  runBackup,
  setBackupConfig,
  setSessionPassphrase,
  testConnection
} from './service'
