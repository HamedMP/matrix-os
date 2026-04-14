export { hashFile } from "./lib/hash.js";
export {
  DEFAULT_PATTERNS,
  parseSyncIgnore,
  isIgnored,
  loadSyncIgnore,
  type SyncIgnorePatterns,
} from "./lib/syncignore.js";
export { loadConfig, saveConfig, type SyncConfig } from "./lib/config.js";
export {
  loadSyncState,
  saveSyncState,
  compareSyncState,
  type SyncAction,
} from "./daemon/manifest-cache.js";
export {
  isTextFile,
  generateConflictPath,
  resolveTextConflict,
  resolveBinaryConflict,
  type ConflictResult,
} from "./daemon/conflict-resolver.js";
export {
  detectChanges,
  buildPresignBatch,
  type ChangeSet,
  type PresignRequest,
  type SyncWarning,
} from "./daemon/sync-engine.js";
export type {
  Manifest,
  ManifestEntry,
  SyncState,
  LocalFileState,
  PeerInfo,
  ConflictRecord,
  SyncEvent,
} from "./daemon/types.js";
