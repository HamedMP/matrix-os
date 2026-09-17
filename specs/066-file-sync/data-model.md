# Data Model: 066 File Sync

> Recovery update: all manifest, blob, peer, local-config, and backup identities
> are scoped by verified `{ownerId, runtimeSlot}`. The legacy single-user paths
> below describe schema ancestry, not the current object layout. Current writes
> use immutable manifest generations plus an accepted pointer, immutable
> hash-addressed blobs, unique staging objects, and profile/scope-specific local
> mapping/state files.

## Entities

### 1. Manifest (R2 JSON)

The central metadata structure. One accepted stream exists per verified
owner/runtime scope. New publications are immutable objects under
`<scope>/manifests/<version>-<sha256>.json`; Postgres stores the accepted key.
`<scope>/manifest.json` is read only for legacy migration when no accepted
pointer exists.

```typescript
// Zod schema (zod/v4)
import { z } from "zod/v4";

export const ManifestEntrySchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.int().nonnegative(),
  mtime: z.int().nonnegative(), // Unix ms
  peerId: z.string().min(1).max(128),
  version: z.int().nonnegative(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ManifestSchema = z.object({
  version: z.literal(2),
  files: z.record(z.string().min(1).max(1024), ManifestEntrySchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;
```

**Fields**:
- `version`: Schema version (always 2)
- `files`: Map of relative file paths to entry metadata
- `files[path].hash`: SHA-256 content hash prefixed with `sha256:`
- `files[path].size`: File size in bytes
- `files[path].mtime`: Last modification time (Unix milliseconds)
- `files[path].peerId`: ID of the peer that last modified this file
- `files[path].version`: Per-file monotonic version counter

**Validation rules**:
- File paths must be relative (no leading `/`), no `..` segments, max 1024 chars
- Hash must be valid SHA-256 hex
- Manifest must have at most 50,000 live entries (enforced at gateway)

---

### 2. Sync Manifest Metadata (Postgres)

Tracks manifest version for optimistic concurrency (since R2 doesn't support conditional writes).

```typescript
// Kysely table definition
export interface SyncManifestsTable {
  user_id: string;       // verified owner ID, composite PRIMARY KEY
  runtime_slot: string;  // verified runtime slot, composite PRIMARY KEY
  version: number;       // Monotonic version counter
  file_count: number;    // Cached count of files in manifest
  total_size: bigint;    // Cached total size in bytes
  etag: string | null;   // R2 ETag for read caching
  accepted_manifest_key: string | null; // immutable generation pointer
  updated_at: Date;
}
```

**State transitions**: `version` increments only when the accepted pointer CAS
succeeds. It never decrements. A generation written before a failed CAS is an
unaccepted orphan and must never be selected by scanning for the highest key.

---

### 3. Sharing Permissions (Postgres)

Access grants for shared folders. One row per share.

```typescript
// Kysely table definition
export interface SyncSharesTable {
  id: string;            // UUID, PRIMARY KEY
  owner_id: string;      // FK to users.id
  path: string;          // Shared path relative to owner's home (e.g., "projects/startup/")
  grantee_id: string;    // FK to users.id
  role: "viewer" | "editor" | "admin";
  accepted: boolean;     // Whether grantee accepted the invite
  created_at: Date;
  expires_at: Date | null; // null = permanent
}
```

```typescript
// Zod schema for API validation
export const ShareRoleSchema = z.enum(["viewer", "editor", "admin"]);

export const CreateShareSchema = z.object({
  path: z.string().min(1).max(1024),
  granteeHandle: z.string().min(1).max(256),
  role: ShareRoleSchema,
  expiresAt: z.iso.datetime().optional(),
});

export const AcceptShareSchema = z.object({
  shareId: z.string().uuid(),
});
```

**Validation rules**:
- Path must be a valid relative path within the owner's home directory
- Grantee must be a valid Matrix OS user
- Only one active share per (owner, path, grantee) combination — enforce with UNIQUE constraint
- Owner cannot share with themselves

**Role enforcement**:

| Role | Read files | Write files | Reshare | Delete |
|------|-----------|-------------|---------|--------|
| viewer | yes | no | no | no |
| editor | yes | yes | no | no |
| admin | yes | yes | yes | yes |

---

### 4. Peer Identity

Peer identity is derived locally, not stored centrally. Each device registers with the gateway on connect.

```typescript
export const PeerInfoSchema = z.object({
  peerId: z.string().min(1).max(128),   // e.g., "hamed-macbook"
  userId: z.string().min(1).max(256),   // Matrix OS user ID
  hostname: z.string().max(256),
  platform: z.enum(["darwin", "linux", "win32"]),
  clientVersion: z.string().max(64),
  connectedAt: z.int().nonnegative(),   // Unix ms
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;
```

Peers are tracked in-memory at the gateway (with a bounded Map, max 100 peers per user, LRU eviction). Not persisted to database — peers re-register on reconnect.

---

### 5. Sync state (local)

Current state is stored beneath the same profile/scope directory as mapping
configuration. Legacy `~/.matrixos/sync-state.json` is migration input only.

Cached manifest + local file state on the client side.

```typescript
export const LocalFileStateSchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  mtime: z.int().nonnegative(),
  size: z.int().nonnegative(),
  lastSyncedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
});

export const SyncStateSchema = z.object({
  manifestVersion: z.int().nonnegative(),
  lastSyncAt: z.int().nonnegative(),
  files: z.record(z.string(), LocalFileStateSchema),
});
export type SyncState = z.infer<typeof SyncStateSchema>;
```

**Fields**:
- `manifestVersion`: Last known manifest version from gateway
- `lastSyncAt`: Timestamp of last successful sync cycle
- `files[path].hash`: Current local file hash
- `files[path].lastSyncedHash`: Hash at time of last successful sync (for conflict detection)

**Conflict detection logic**:
```
localChanged  = file.hash !== file.lastSyncedHash
remoteChanged = manifest[path].hash !== file.lastSyncedHash
conflict      = localChanged && remoteChanged && file.hash !== manifest[path].hash
```

---

### 6. Sync mapping config (local)

Current location:
`~/.matrixos/profiles/<profile>/sync/<scope-id>/config.json`. The scope ID is a
deterministic digest of owner and runtime slot and is never supplied by an
unverified remote input.

```typescript
export const SyncMappingConfigSchema = z.object({
  schemaVersion: z.literal(2),
  revision: z.int().nonnegative(),
  profile: z.string(),
  ownerId: z.string(),
  runtimeSlot: z.string(),
  deviceId: z.string(),
  enabled: z.boolean(),
  mappings: z.array(z.object({
    id: z.uuid(),
    label: z.string(),
    localRoot: z.string(),
    remotePrefix: z.string(),
    direction: z.enum(["two_way", "to_matrix", "to_local"]),
    enabled: z.boolean(),
    propagateDeletes: z.boolean(),
    excludes: z.array(z.string()),
  })).max(32),
});
export type SyncMappingConfig = z.infer<typeof SyncMappingConfigSchema>;
```

Mutations carry `expectedRevision`; saving requires exactly
`revision === expectedRevision + 1` under an exclusive lock. Legacy
`config.json` remains only as the daemon/service compatibility projection and
is migrated idempotently into this source of truth.

---

### 7. Conflict Record

Created when automatic resolution fails.

```typescript
export const ConflictRecordSchema = z.object({
  path: z.string().min(1).max(1024),       // Original file path
  conflictPath: z.string().min(1),         // Path of conflict copy
  localHash: z.string(),
  remoteHash: z.string(),
  remotePeerId: z.string(),
  detectedAt: z.int().nonnegative(),       // Unix ms
  resolved: z.boolean().default(false),
  resolvedAt: z.int().nonnegative().optional(),
});
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;
```

Conflict copies follow the naming convention: `filename (conflict - peerId - YYYY-MM-DD).ext`

---

## Entity Relationships

```
User (Postgres: users)
  |
  |-- 1:1 -- SyncManifest (Postgres: sync_manifests)
  |             |
  |             |-- references --> Manifest (R2: {userId}/manifest.json)
  |
  |-- 1:N -- SyncShares (Postgres: sync_shares) -- as owner
  |
  |-- 1:N -- SyncShares (Postgres: sync_shares) -- as grantee
  |
  |-- 1:N -- Peers (in-memory, bounded Map at gateway)

Manifest (R2 JSON)
  |
  |-- contains --> ManifestEntry per file

SyncState (local JSON)
  |
  |-- mirrors --> Manifest (cached locally)
  |
  |-- contains --> LocalFileState per file
  |
  |-- contains --> ConflictRecord per unresolved conflict
```

## Database Migrations

### Postgres: Add `sync_manifests` table

```sql
CREATE TABLE sync_manifests (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_size BIGINT NOT NULL DEFAULT 0,
  etag TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Postgres: Add `sync_shares` table

```sql
CREATE TABLE sync_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  grantee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  accepted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  UNIQUE (owner_id, path, grantee_id),
  CHECK (owner_id != grantee_id)
);

CREATE INDEX idx_sync_shares_grantee ON sync_shares(grantee_id);
CREATE INDEX idx_sync_shares_owner ON sync_shares(owner_id);
```
