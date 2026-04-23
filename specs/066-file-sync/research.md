# Research: 066 File Sync

Phase 0 research consolidating findings on R2 presigned URLs, 3-way text merge, and CLI daemon patterns.

## 1. R2 Presigned URLs

### Decision
Use `@aws-sdk/s3-request-presigner` with `getSignedUrl()` for both PUT (upload) and GET (download) presigned URLs against Cloudflare R2.

### Rationale
R2 is S3-compatible and supports the standard AWS SDK presigning flow. The gateway generates presigned URLs so clients upload/download directly to R2 without proxying through the gateway. This eliminates the gateway as a bandwidth bottleneck.

### Key Findings

**API usage**:
```typescript
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const client = new S3Client({
  region: "auto",  // R2 requires "auto", not a real AWS region
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

// Presigned GET (download)
const getUrl = await getSignedUrl(client, new GetObjectCommand({
  Bucket: "matrixos-sync", Key: `${userId}/files/${path}`,
}), { expiresIn: 900 }); // 15 minutes

// Presigned PUT (upload)
const putUrl = await getSignedUrl(client, new PutObjectCommand({
  Bucket: "matrixos-sync", Key: `${userId}/files/${path}`,
}), { expiresIn: 900 });
```

**Critical limitation**: R2 does NOT support `If-Match`/`If-None-Match` on PutObject. These conditional headers are silently ignored on writes. This means the spec's "PUT manifest with If-Match" approach won't work directly against R2.

**Implication for manifest concurrency**: The gateway must own all manifest writes. Design:
1. Gateway reads manifest from R2 (ETag works on GET for caching)
2. Gateway holds an in-memory lock or uses Postgres-backed versioning per user
3. Gateway applies changes to manifest
4. Gateway writes updated manifest back to R2
5. Concurrent manifest updates are serialized at the gateway, not R2

**Other R2 specifics**:
- Max presigned URL expiry: 7 days (use 15 min for security)
- Multipart upload supported via `CreateMultipartUploadCommand` + per-part presigned URLs
- CORS must be configured on R2 bucket for browser-based uploads
- `Content-MD5` supported for integrity, but `x-amz-checksum-*` headers are not
- `signatureVersion` is always v4

### Alternatives Considered
- **Gateway proxying file content**: Rejected. Creates bandwidth bottleneck, defeats the purpose of R2 as CDN.
- **R2 conditional writes**: Not available. Would have been ideal for direct client manifest updates.
- **R2 Workers with Durable Objects**: Overkill for this use case. Adds Cloudflare Worker dependency.

### New Dependency
`@aws-sdk/s3-request-presigner` — already using `@aws-sdk/client-s3` in gateway, this is a lightweight addition.

---

## 2. 3-Way Text Merge

### Decision
Use `node-diff3` (v3.2.0) for 3-way text merge in conflict resolution.

### Rationale
Direct port of GNU diff3/diffutils algorithms. Purpose-built for exactly this use case. Actively maintained, built-in TypeScript types, ESM support.

### Key Findings

**API usage**:
```typescript
import { diff3Merge, merge } from "node-diff3";

// Structured result for programmatic handling
const regions = diff3Merge(localContent, baseContent, remoteContent);
const hasConflicts = regions.some(r => "conflict" in r);

for (const r of regions) {
  if ("ok" in r) {
    // Clean merge — both sides agree or only one side changed
  }
  if ("conflict" in r) {
    // Unresolvable — r.conflict has { a, o, b } (local, base, remote)
  }
}

// Flat string with git-style conflict markers
const result = merge(localContent, baseContent, remoteContent);
if (result.conflict) {
  // Write conflict file with <<<<<<< / ======= / >>>>>>> markers
}
const merged = result.result.join("\n");
```

**Usage in sync engine**: Use `diff3Merge()` for programmatic conflict detection (structured regions), then `merge()` to produce human-readable conflict files when auto-merge fails.

### Alternatives Considered
- **`diff` package**: 2-way only, no 3-way merge support.
- **`diff3` (v0.0.4)**: Abandoned (2022), no types, low downloads.
- **`three-way-merge`**: Dead project (8 years old).
- **Rolling our own**: Unnecessary when `node-diff3` implements the exact GNU algorithm.

### New Dependency
`node-diff3` — ~64K weekly downloads, Oct 2025 last update, built-in `.d.ts`.

---

## 3. CLI Framework + Daemon Architecture

### Decision
Use `citty` (UnJS) for CLI framework, Unix domain socket for IPC, launchd/systemd for daemon management.

### Rationale
Citty is ESM-first, TypeScript-first, lightweight, and supports subcommands natively. Unix sockets avoid port conflicts and provide filesystem-level permissions. Platform service managers (launchd/systemd) handle daemon lifecycle reliably.

### Key Findings

**CLI framework (`citty`)**:
```typescript
import { defineCommand, runMain } from "citty";

const sync = defineCommand({
  meta: { name: "sync", description: "Manage file sync" },
  args: {
    path: { type: "positional", description: "Local folder to sync", required: false },
  },
  subCommands: {
    status: defineCommand({ /* ... */ }),
    pause:  defineCommand({ /* ... */ }),
    resume: defineCommand({ /* ... */ }),
  },
  run({ args }) {
    // Start sync daemon for args.path
  },
});

const main = defineCommand({
  meta: { name: "matrixos", description: "Matrix OS CLI" },
  subCommands: { sync, login, logout, share, peers, ssh, keys },
});

runMain(main);
```

**Daemon management**:
- macOS: launchd plist at `~/Library/LaunchAgents/com.matrixos.sync.plist` with `KeepAlive`, log paths to `~/.matrixos/logs/`
- Linux: systemd user unit at `~/.config/systemd/user/matrixos-sync.service` with `Restart=on-failure`
- CLI `matrixos sync start` writes the appropriate service file and starts via `launchctl load` or `systemctl --user enable --now`

**IPC (Unix domain socket)**:
- Socket at `~/.matrixos/daemon.sock`
- Node.js `net.createServer()` with newline-delimited JSON protocol
- No port conflicts, filesystem-permissioned, no network exposure
- PID file at `~/.matrixos/daemon.pid` for process detection

**Logging**:
- `pino` with `pino.destination()` for async file writes to `~/.matrixos/logs/sync.log`
- Rotation: `pino-roll` (10MB size-based, keep 5 files)
- CLI `matrixos logs` tails the log file directly

**Local directory structure**:
```
~/.matrixos/
  auth.json          # OAuth JWT + refresh token (0600 permissions)
  config.json        # Sync preferences, gateway URL, selective sync
  sync-state.json    # Cached manifest
  daemon.pid         # PID file for process detection
  daemon.sock        # Unix socket for CLI <-> daemon IPC
  logs/
    sync.log         # Daemon logs (pino, rotated)
```

### Alternatives Considered
- **Commander.js**: CJS-oriented, heavier. Citty is more aligned with the UnJS/ESM ecosystem.
- **Yargs**: Poor ESM support, complex API.
- **HTTP on localhost**: Port conflicts possible, unnecessary overhead for local IPC.
- **Named pipes**: Cross-platform quirks, less ergonomic than Unix sockets.

### New Dependencies
- `citty` — CLI framework (UnJS, ESM-first)
- `pino` + `pino-roll` — Daemon logging with rotation

---

## 4. OAuth Device Flow (for `matrixos login`)

### Decision
Use Clerk's OAuth device authorization flow. The CLI opens a browser to matrix-os.com for consent, receives a signed JWT.

### Rationale
Matrix OS already uses Clerk for auth. The device flow is standard OAuth 2.0 and works well for CLI tools — user authenticates in browser, CLI polls for token.

### Key Design
1. CLI generates a device code + user code
2. Opens browser to `matrix-os.com/device?code=USER_CODE`
3. Polls Clerk's token endpoint until user completes auth
4. Receives signed JWT + refresh token
5. Stores in `~/.matrixos/auth.json` with `0600` permissions

### Alternatives Considered
- **Static API key**: Less secure, no expiry, no revocation without platform changes.
- **SSH key-based auth**: Would require separate key management infrastructure.

---

## 5. Manifest Concurrency (Gateway-Managed)

### Decision
Gateway owns all manifest writes using a Postgres-backed version counter per user. No direct R2 conditional writes.

### Rationale
R2 does not support `If-Match` on PutObject. The gateway must serialize manifest updates to prevent race conditions between peers.

### Design

```
Postgres table: sync_manifests
  user_id TEXT PRIMARY KEY
  version INTEGER NOT NULL DEFAULT 0
  etag TEXT  -- R2 ETag of current manifest, for read caching
  updated_at TIMESTAMP
```

**Write flow**:
1. Peer sends `POST /api/sync/commit` with file changes + expected manifest version
2. Gateway acquires per-user advisory lock: `SELECT pg_advisory_xact_lock(hashtext(user_id))`
3. Gateway reads current manifest from R2 (or cache)
4. Verifies expected version matches current version (optimistic concurrency)
5. Applies file changes to manifest
6. Writes updated manifest to R2
7. Increments version in Postgres
8. Releases lock (transaction commit)
9. Broadcasts `sync:change` to other peers

**Read flow**:
1. Peer sends `GET /api/sync/manifest`
2. Gateway fetches from R2 with `If-None-Match` (ETag caching works on GET)
3. Returns manifest + version number

This gives us the optimistic concurrency the spec requires without relying on R2 conditional writes.

### Alternatives Considered
- **Redis distributed lock**: Adds dependency. Postgres advisory locks are sufficient for our scale.
- **In-memory lock**: Doesn't survive gateway restart. Postgres is durable.
- **Client-side merge**: Complex, error-prone, doesn't prevent TOCTOU races.
