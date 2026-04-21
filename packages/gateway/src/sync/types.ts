import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Manifest (R2 JSON)
// ---------------------------------------------------------------------------

export const ManifestEntrySchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.int().nonnegative(),
  mtime: z.int().nonnegative(),
  peerId: z.string().min(1).max(128),
  version: z.int().nonnegative(),
  deleted: z.boolean().optional(),
  deletedAt: z.int().nonnegative().optional(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ManifestSchema = z.object({
  version: z.literal(2),
  files: z.record(z.string().min(1).max(1024), ManifestEntrySchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// Peer identity
// ---------------------------------------------------------------------------

export const PeerInfoSchema = z.object({
  peerId: z.string().min(1).max(128),
  userId: z.string().min(1).max(256),
  hostname: z.string().max(256),
  platform: z.enum(["darwin", "linux", "win32"]),
  clientVersion: z.string().max(64),
  connectedAt: z.int().nonnegative(),
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

// ---------------------------------------------------------------------------
// Conflict record
// ---------------------------------------------------------------------------

export const ConflictRecordSchema = z.object({
  path: z.string().min(1).max(1024),
  conflictPath: z.string().min(1),
  localHash: z.string(),
  remoteHash: z.string(),
  remotePeerId: z.string(),
  detectedAt: z.int().nonnegative(),
  resolved: z.boolean().default(false),
  resolvedAt: z.int().nonnegative().optional(),
});
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;

// ---------------------------------------------------------------------------
// Sync config (local client)
// ---------------------------------------------------------------------------

export const SyncConfigSchema = z.object({
  gatewayUrl: z.url(),
  syncPath: z.string().min(1),
  peerId: z.string().min(1).max(128),
  folders: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  pauseSync: z.boolean().default(false),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

// ---------------------------------------------------------------------------
// Local file state (client-side cached state)
// ---------------------------------------------------------------------------

export const LocalFileStateSchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  mtime: z.int().nonnegative(),
  size: z.int().nonnegative(),
  lastSyncedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
});
export type LocalFileState = z.infer<typeof LocalFileStateSchema>;

export const SyncStateSchema = z.object({
  manifestVersion: z.int().nonnegative(),
  lastSyncAt: z.int().nonnegative(),
  files: z.record(z.string(), LocalFileStateSchema),
});
export type SyncState = z.infer<typeof SyncStateSchema>;

// ---------------------------------------------------------------------------
// Presign request / response
// ---------------------------------------------------------------------------

const PresignGetFileSchema = z.object({
  path: z.string().min(1).max(1024),
  action: z.literal("get"),
});

const PresignPutFileSchema = z.object({
  path: z.string().min(1).max(1024),
  action: z.literal("put"),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.int().positive().max(1024 * 1024 * 1024), // 1GB max (multipart for >100MB)
});

export const PresignFileSchema = z.discriminatedUnion("action", [
  PresignGetFileSchema,
  PresignPutFileSchema,
]);
export type PresignFile = z.infer<typeof PresignFileSchema>;

export const PresignRequestSchema = z.object({
  files: z.array(PresignFileSchema).min(1).max(100),
});
export type PresignRequest = z.infer<typeof PresignRequestSchema>;

// ---------------------------------------------------------------------------
// Commit request / response
// ---------------------------------------------------------------------------

export const CommitFileSchema = z.object({
  path: z.string().min(1).max(1024),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.int().nonnegative(),
  action: z.enum(["add", "update", "delete"]).optional(),
});
export type CommitFile = z.infer<typeof CommitFileSchema>;

export const CommitRequestSchema = z.object({
  files: z.array(CommitFileSchema).min(1).max(100),
  expectedVersion: z.int().nonnegative(),
});
export type CommitRequest = z.infer<typeof CommitRequestSchema>;

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

export const ResolveConflictSchema = z.object({
  path: z.string().min(1).max(1024),
  resolution: z.enum(["keep-local", "keep-remote", "keep-merged"]),
  conflictPath: z.string().min(1).max(1024).optional(),
});
export type ResolveConflict = z.infer<typeof ResolveConflictSchema>;

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export const ShareRoleSchema = z.enum(["viewer", "editor", "admin"]);
export type ShareRole = z.infer<typeof ShareRoleSchema>;
export const SHARE_HANDLE_SCHEMA = z.string().regex(
  /^@[a-z][a-z0-9_-]{0,62}:matrix-os\.com$/,
  "Invalid Matrix OS handle",
);

export const CreateShareSchema = z.object({
  path: z.string().min(1).max(1024),
  granteeHandle: SHARE_HANDLE_SCHEMA,
  role: ShareRoleSchema,
  expiresAt: z.iso.datetime().optional(),
});
export type CreateShare = z.infer<typeof CreateShareSchema>;

export const AcceptShareSchema = z.object({
  shareId: z.string().uuid(),
});
export type AcceptShare = z.infer<typeof AcceptShareSchema>;

export const DeleteShareSchema = z.object({
  shareId: z.string().uuid(),
});
export type DeleteShare = z.infer<typeof DeleteShareSchema>;
