# Data Model: 066 File Sync

## Entities

### 1. Manifest (R2 JSON)

The central metadata structure. One per user, stored at `matrixos-sync/{userId}/manifest.json` in R2.

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
- Manifest must have fewer than 10,000 entries (enforced at gateway)

---

### 2. Sync Manifest Metadata (Postgres)

Tracks manifest version for optimistic concurrency (since R2 doesn't support conditional writes).

```typescript
// Kysely table definition
export interface SyncManifestsTable {
  user_id: string;       // FK to users.id, PRIMARY KEY
  version: number;       // Monotonic version counter
  file_count: number;    // Cached count of files in manifest
  total_size: bigint;    // Cached total size in bytes
  etag: string | null;   // R2 ETag for read caching
  updated_at: Date;
}
```

**State transitions**: `version` increments on every manifest write. Never decrements.

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

### 5. Sync State (Local — `~/.matrixos/sync-state.json`)

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

### 6. Sync Config (Local — `~/.matrixos/config.json`)

```typescript
export const SyncConfigSchema = z.object({
  gatewayUrl: z.url(),
  syncPath: z.string().min(1),         // Local folder to sync (default: ~/matrixos/)
  peerId: z.string().min(1).max(128),
  folders: z.array(z.string()).optional(),   // Selective sync: which folders to include
  exclude: z.array(z.string()).optional(),   // Additional exclude patterns
  pauseSync: z.boolean().default(false),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;
```

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
