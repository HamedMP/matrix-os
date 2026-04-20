# Quickstart: 066 File Sync

## Prerequisites

- Node.js 24+
- pnpm (install), bun (run scripts)
- Cloudflare R2 bucket (`matrixos-sync`) with:
  - S3-compatible API credentials (access key + secret)
  - CORS configured for `http://localhost:3000` and `https://matrix-os.com`
- PostgreSQL database (existing platform-db)

## Environment Variables

Add to `.env` (or Docker env):

```bash
# R2 / S3-compatible storage
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET=matrixos-sync
R2_ENDPOINT=https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com

# Existing
POSTGRES_URL=postgresql://...
MATRIX_AUTH_TOKEN=...
```

## Development Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Run database migrations

The sync tables (`sync_manifests`, `sync_shares`) are added via the platform-db migration system:

```bash
bun run migrate
```

### 3. Start the gateway (with sync API)

```bash
bun run dev
# Gateway runs on :4000, shell on :3000
```

### 4. Build and run the sync client (development)

```bash
cd packages/sync-client
bun run dev -- login                  # OAuth device flow
bun run dev -- sync ~/matrixos        # Start sync daemon (foreground, for development)
bun run dev -- sync status            # Check sync state
```

### 5. Docker development

```bash
bun run docker        # Gateway + shell
bun run docker:full   # + proxy, platform, conduit
```

## Testing

```bash
# Unit tests (sync engine, manifest, conflict resolution)
bun run test

# Integration tests (gateway sync API, WebSocket events)
bun run test:integration

# Specific test file
bun run test packages/gateway/src/sync/__tests__/manifest.test.ts
bun run test packages/sync-client/tests/unit/conflict-resolver.test.ts
```

## Manual Testing Flow

1. **Single peer sync**:
   ```bash
   # Terminal 1: Start gateway
   bun run dev

   # Terminal 2: Create a test file
   echo "hello" > ~/matrixos/test.txt

   # Terminal 3: Start sync daemon
   cd packages/sync-client && bun run dev -- sync ~/matrixos

   # Check that test.txt appears in R2 (via AWS CLI or R2 dashboard)
   ```

2. **Two-peer sync**:
   ```bash
   # Peer A: Start daemon syncing ~/matrixos-a/
   # Peer B: Start daemon syncing ~/matrixos-b/
   # Create file on Peer A, verify it appears on Peer B
   ```

3. **Conflict resolution**:
   ```bash
   # Pause Peer B's daemon
   # Modify same file on both peers
   # Resume Peer B's daemon
   # Verify conflict detection + conflict copy creation
   ```

## Key Files

| File | Purpose |
|------|---------|
| `packages/gateway/src/sync/routes.ts` | Sync REST API endpoints |
| `packages/gateway/src/sync/manifest.ts` | Manifest read/write with Postgres versioning |
| `packages/gateway/src/sync/presign.ts` | R2 presigned URL generation |
| `packages/gateway/src/sync/ws-events.ts` | WebSocket event broadcasting |
| `packages/gateway/src/sync/conflict.ts` | Conflict detection + 3-way merge |
| `packages/gateway/src/sync/sharing.ts` | Sharing permissions CRUD |
| `packages/sync-client/src/daemon/sync-engine.ts` | Client-side sync loop |
| `packages/sync-client/src/daemon/watcher.ts` | File watching (chokidar) |
| `packages/sync-client/src/cli/index.ts` | CLI entry point |
