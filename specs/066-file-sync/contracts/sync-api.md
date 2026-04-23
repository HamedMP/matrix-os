# API Contracts: Sync REST Endpoints

All endpoints require `Authorization: Bearer <jwt>` header.
All mutating endpoints have `bodyLimit({ maxSize: 65536 })`.
All R2 operations use `AbortSignal.timeout(10_000)`.

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

**Headers**:
- `ETag`: Current manifest ETag for client caching

---

## POST /api/sync/presign

Request presigned R2 URLs for direct file upload/download. Gateway validates auth and permissions, then returns scoped URLs.

**Request Body**:
```typescript
{
  files: Array<{
    path: string,              // Relative file path
    action: "put" | "get",     // Upload or download
    hash?: string,             // Required for "put" — content hash for verification
    size?: number,             // Required for "put" — file size for quota checks
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
  size: z.int().nonnegative().max(100 * 1024 * 1024).optional(), // 100MB max
});

const PresignRequestSchema = z.object({
  files: z.array(PresignFileSchema).min(1).max(100),
});
```

**Response 200**:
```typescript
{
  urls: Array<{
    path: string,
    url: string,          // Presigned R2 URL (valid 15 min)
    expiresIn: number,    // Seconds until expiry (900)
  }>
}
```

**Response 400**: Validation error (invalid paths, exceeds batch limit).
**Response 401**: Invalid JWT.
**Response 403**: Path outside user's prefix or insufficient share permissions.
**Response 429**: Rate limit exceeded (100 req/min per user).

**Security**:
- Every `path` is validated with `resolveWithinPrefix(userId, path)`
- For shared folders: checks `sync_shares` table for grantee permissions
- `action: "put"` requires editor or admin role on shared paths
- `action: "get"` requires viewer or higher role on shared paths

---

## POST /api/sync/commit

Called after client completes direct upload to R2. Updates the manifest and broadcasts change events to peers.

**Request Body**:
```typescript
{
  files: Array<{
    path: string,        // Relative file path (same as presign request)
    hash: string,        // SHA-256 hash of uploaded content
    size: number,        // File size in bytes
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
});

const CommitRequestSchema = z.object({
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

**Server-side behavior**:
1. Acquire Postgres advisory lock for user: `pg_advisory_xact_lock(hashtext(user_id))`
2. Read current manifest version from `sync_manifests`
3. If `expectedVersion !== currentVersion`: return 409
4. Read manifest from R2
5. Apply file changes (update entries with new hash/size/mtime/peerId/version)
6. Write updated manifest to R2
7. Update `sync_manifests` (increment version, update file_count, total_size, etag)
8. Release lock (transaction commit)
9. Broadcast `sync:change` events via WebSocket

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
}
```

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
