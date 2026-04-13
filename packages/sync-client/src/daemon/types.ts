import { z } from "zod/v4";

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

export const PeerInfoSchema = z.object({
  peerId: z.string().min(1).max(128),
  userId: z.string().min(1).max(256),
  hostname: z.string().max(256),
  platform: z.enum(["darwin", "linux", "win32"]),
  clientVersion: z.string().max(64),
  connectedAt: z.int().nonnegative(),
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

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

export type SyncChangeEvent = {
  type: "sync:change";
  path: string;
  hash: string;
  peerId: string;
  action: "create" | "update" | "delete";
};

export type SyncConflictEvent = {
  type: "sync:conflict";
  path: string;
  localHash: string;
  remoteHash: string;
  conflictPath: string;
};

export type SyncEvent = SyncChangeEvent | SyncConflictEvent;
