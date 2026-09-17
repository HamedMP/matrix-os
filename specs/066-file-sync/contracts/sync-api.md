# API Contracts: Sync REST Endpoints

All endpoints require a verified bearer principal. The gateway derives
`{ownerId, runtimeSlot}` from that principal; clients cannot select another
scope with a header, body field, handle, or path. Sync-device grants are
capability-restricted to the sync route family.

| Route | Auth | Body cap | Notes |
| --- | --- | --- | --- |
| `GET /manifest`, `/status`, `/backup-status`, `/shares` | verified owner/runtime bearer | none | read only |
| `POST /presign`, `/commit`, `/multipart/abort`, `/resolve-conflict`, `/share`, `/share/accept`; `DELETE /share` | verified owner/runtime bearer | 64 KiB | per-scope rate limits |
| `POST /multipart/complete` | verified owner/runtime bearer | 1 MiB | bounded 10,000-part receipt |

Publication endpoints require `protocolVersion: 3`; older or missing versions
receive HTTP 426 with the required version. External storage calls are bounded.
Client errors are generic; provider names, keys, bucket details, and raw
failures stay server-side.

The platform-internal storage broker additionally exposes authenticated,
owner/runtime-derived maintenance listings for the exact `staging/` and
`manifests/` prefixes. Each response is capped at 1,000 entries and every
provider call has a ten-second timeout. Arbitrary prefixes and immutable blob
listing are forbidden.

Base path: `/api/sync`

---

## GET /api/sync/manifest

Fetch the current sync manifest for the authenticated user.

**Query Parameters**:
```typescript
// None — user is identified from JWT
```

**Response 200**:
```typescript
{
  manifest: {
    version: 2,
    files: Record<string, {
      hash: string,      // "sha256:abc123..."
      size: number,
      mtime: number,     // Unix ms
      peerId: string,
      version: number,
    }>
  },
  manifestVersion: number,   // Postgres version counter
  etag: string,              // R2 ETag (for client caching)
}
```

**Response 304**: Not modified (when client sends `If-None-Match` matching current ETag).

**Response 401**: Invalid or missing JWT.

**Status caveat**: Shared-folder manifest filtering is target behavior tracked by F19 in `../follow-ups.md`. Current `/api/sync/manifest` responses are caller-namespace only.

**Headers**:
- `ETag`: Current manifest ETag for client caching

---

## POST /api/sync/presign

Request presigned R2 URLs for direct file upload/download. Gateway validates auth and permissions, then returns scoped URLs.

**Request Body**:
```typescript
{
  protocolVersion: 3,
  files: Array<{
    path: string,              // Relative file path
    action: "put" | "get",     // Upload or download
    hash?: string,             // Required for "put" — content hash for verification
    size?: number,             // Required for "put" — 1 GiB hard limit
  }>
}
```

**Validation**:
```typescript
import { z } from "zod/v4";

const PresignFileSchema = z.object({
  path: z.string().min(1).max(1024),
  action: z.enum(["put", "get"]),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  size: z.int().nonnegative().max(1024 * 1024 * 1024).optional(),
});

const PresignRequestSchema = z.object({
  protocolVersion: z.literal(3),
  files: z.array(PresignFileSchema).min(1).max(100),
});
```

**Response 200**:
```typescript
{
  urls: Array<{
    path: string,
    url: string,          // Presigned R2 URL (valid 15 min); empty for multipart PUT
    expiresIn: number,    // Seconds until expiry (900)
    stagingId?: string,   // UUID for each PUT; never an accepted object key
    multipart?: {         // Present for PUT files >100 MiB
      uploadId: string,
      partUrls: string[],
      partSize: number,
    },
  }>
}
```

**Response 400**: Validation error (invalid paths, exceeds batch limit).
**Response 401**: Invalid JWT.
**Response 403**: Path outside user's prefix or insufficient share permissions.
**Response 429**: Rate limit exceeded (100 req/min per user).

**Status caveat**: Shared-folder permission checks in this contract are target behavior tracked by F19 in `../follow-ups.md`. Current `/api/sync/presign` and `/api/sync/commit` data-plane routes are caller-namespace only.

**Security**:
- Every `path` is validated with `resolveWithinPrefix(userId, path)`
- For shared folders *(target behavior — not yet wired; see F19 status caveat above)*: checks `sync_shares` table for grantee permissions
- `action: "put"` requires editor or admin role on shared paths
- `action: "get"` requires viewer or higher role on shared paths

---

## POST /api/sync/multipart/complete

Called after the client uploads every multipart part directly to R2. Finalizes the R2 object before the client calls `/api/sync/commit`.

**Request Body**:
```typescript
{
  protocolVersion: 3,
  path: string,
  stagingId: string,
  uploadId: string,
  parts: Array<{
    partNumber: number,
    etag: string,
  }>,
}
```

**Response 200**:
```typescript
{ etag: string | null }
```

**Response 400**: Validation error or invalid path.
**Response 401**: Invalid JWT.
**Response 429**: Rate limit exceeded.

---

## POST /api/sync/multipart/abort

Best-effort cleanup call used when multipart upload fails before completion.

**Request Body**:
```typescript
{
  protocolVersion: 3,
  path: string,
  stagingId: string,
  uploadId: string,
}
```

**Response 200**:
```typescript
{ ok: true }
```

**Response 400**: Validation error or invalid path.
**Response 401**: Invalid JWT.
**Response 429**: Rate limit exceeded.

---

## POST /api/sync/commit

Called after upload to a unique staging object. The gateway verifies staged
hash and size, finalizes an immutable blob, publishes an immutable manifest
generation, advances the accepted pointer under optimistic concurrency, and
only then broadcasts. A losing writer cannot overwrite bytes referenced by an
accepted generation.

**Request Body**:
```typescript
{
  protocolVersion: 3,
  files: Array<{
    path: string,        // Relative file path (same as presign request)
    hash: string,        // SHA-256 hash of uploaded content
    size: number,        // File size in bytes
    action?: "add" | "update" | "delete",
    stagingId?: string,  // required unless action is delete
  }>,
  expectedVersion: number,  // Client's expected manifest version (optimistic concurrency)
}
```

**Validation**:
```typescript
const CommitFileSchema = z.object({
  path: z.string().min(1).max(1024),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.int().nonnegative(),
  action: z.enum(["add", "update", "delete"]).optional(),
  stagingId: z.uuid().optional(),
});

const CommitRequestSchema = z.object({
  protocolVersion: z.literal(3),
  files: z.array(CommitFileSchema).min(1).max(100),
  expectedVersion: z.int().nonnegative(),
});
```

**Response 200**:
```typescript
{
  manifestVersion: number,    // New version after commit
  committed: number,          // Number of files committed
}
```

**Response 409**: Version conflict — another peer committed since the client's last read. Client must re-fetch manifest and retry.
```typescript
{
  error: "version_conflict",
  currentVersion: number,
  expectedVersion: number,
}
```

**Response 400**: Validation error.
**Response 401**: Invalid JWT.
**Response 403**: Insufficient permissions.

**Status caveat**: Shared-folder commit authorization is target behavior tracked by F19 in `../follow-ups.md`; the current commit route is caller-namespace only.

**Server-side behavior**:
1. Validate every path, then verify each staged object's exact hash and size
   before the database transaction. Copy valid bytes to the immutable
   content-addressed key and best-effort remove the staging object. A zero-byte
   object is valid.
2. Acquire the owner/runtime-scoped Postgres advisory lock.
3. Read the accepted pointer and current immutable generation.
4. If `expectedVersion !== currentVersion`, return 409. The finalized blob is
   an unreferenced, reclaimable orphan; accepted bytes remain unchanged.
5. Write the next immutable manifest generation.
6. Advance the accepted pointer and metadata with a compare-and-swap inside the
   transaction. A lost CAS leaves only reclaimable immutable orphans.
7. Commit and broadcast the accepted revision. Never broadcast before
   acceptance.

---

## GET /api/sync/status

Sync health dashboard for the authenticated user.

**Response 200**:
```typescript
{
  connectedPeers: Array<{
    peerId: string,
    hostname: string,
    platform: string,
    connectedAt: number,     // Unix ms
  }>,
  manifestVersion: number,
  fileCount: number,
  totalSize: number,         // Bytes
  lastSyncAt: number,        // Unix ms
  pendingConflicts: number,
  protocolVersion: 3,
  capabilities: {
    stagedUploads: true,
    immutableBlobs: true,
    immutableManifestGenerations: true,
  },
}
```

---

## GET /api/sync/backup-status

Returns coarse, bounded database-backup health for the authenticated runtime.
This endpoint does not expose provider names, credentials, or raw command
errors.

```typescript
{
  schemaVersion: 1,
  scheduler: {
    enabled: boolean | null,
    active: boolean | null,
    nextDueAt: number | null,
  },
  lastAttempt: {
    attemptedAt: number,
    outcome: "running" | "success" | "failed",
    errorCode: string | null,
  } | null,
  lastSuccess: {
    snapshotKey: string,
    receiptKey: string,
    sha256: string,
    size: number,
    runtimeSlot: string,
    completedAt: number,
    restoreVerifiedAt: number | null,
  } | null,
  storageReachability: "reachable" | "unreachable" | "unknown",
  freshness: "healthy" | "stale" | "critical" | "unknown",
  observedAt: number,
}
```

HTTP 503 means backup status is not configured or cannot be read safely. A
newer failed attempt does not replace `lastSuccess`.

---

## POST /api/sync/resolve-conflict

Mark a conflict as resolved.

**Request Body**:
```typescript
{
  path: string,             // Original file path
  resolution: "keep-local" | "keep-remote" | "keep-merged",
  conflictPath?: string,    // Path of conflict copy to delete (if resolution removes it)
}
```

**Validation**:
```typescript
const ResolveConflictSchema = z.object({
  path: z.string().min(1).max(1024),
  resolution: z.enum(["keep-local", "keep-remote", "keep-merged"]),
  conflictPath: z.string().min(1).max(1024).optional(),
});
```

**Response 200**:
```typescript
{ resolved: true }
```

---

## POST /api/sync/share

Create a sharing grant for a folder.

**Request Body**:
```typescript
{
  path: string,                  // Relative path to share
  granteeHandle: string,        // e.g., "@colleague:matrix-os.com"
  role: "viewer" | "editor" | "admin",
  expiresAt?: string,           // ISO datetime, optional
}
```

**Response 201**:
```typescript
{
  shareId: string,    // UUID
  path: string,
  granteeHandle: string,
  role: string,
}
```

**Response 400**: Invalid path or handle.
**Response 404**: Grantee not found.
**Response 409**: Share already exists for this (owner, path, grantee).

---

## DELETE /api/sync/share

Revoke a sharing grant.

**Request Body**:
```typescript
{
  shareId: string,    // UUID of the share to revoke
}
```

**Response 200**:
```typescript
{ revoked: true }
```

**Server-side behavior**:
1. Delete row from `sync_shares`
2. Invalidate scoped R2 token for grantee
3. Send `sync:access-revoked` WebSocket event to grantee

---

## POST /api/sync/share/accept

Accept a share invitation.

**Request Body**:
```typescript
{
  shareId: string,    // UUID
}
```

**Response 200**:
```typescript
{
  accepted: true,
  path: string,            // Where shared folder appears locally
  ownerHandle: string,
}
```

---

## GET /api/sync/shares

List active shares (both owned and received).

**Response 200**:
```typescript
{
  owned: Array<{
    id: string,
    path: string,
    granteeHandle: string,
    role: string,
    accepted: boolean,
    createdAt: string,
    expiresAt: string | null,
  }>,
  received: Array<{
    id: string,
    path: string,
    ownerHandle: string,
    role: string,
    accepted: boolean,
    createdAt: string,
    expiresAt: string | null,
  }>,
}
```
