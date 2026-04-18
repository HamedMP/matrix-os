# Sync Testing Guide (066)

How to verify the file sync feature works end-to-end -- from raw HTTP probes
to running the macOS menu bar app.

## What's Running

`bun run docker` brings up the full sync stack:

| Container | Role |
|-----------|------|
| `postgres` | sync_manifests + sync_shares tables |
| `minio` | S3-compatible storage (drop-in for Cloudflare R2) |
| `minio-init` | Auto-creates the `matrixos-sync` bucket on first boot |
| `dev` | Gateway with sync API + Next.js shell |

After startup you should see this in `docker compose logs dev`:
```
[app-db] Postgres connected, data layer ready
[sync] Sync API initialized (S3 endpoint: http://minio:9000 )
```

If the second line is missing, sync is disabled -- check the env vars in
`docker-compose.dev.yml` (`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` must be set
and `DATABASE_URL` must point at a working Postgres).

## Quick Verification (curl)

The gateway runs without the bearer-token middleware in dev mode (no
`MATRIX_AUTH_TOKEN` env var), so curl needs no `Authorization` header.

### 1. Health check

```bash
curl -s http://localhost:4000/api/sync/status | jq
```

Expected:
```json
{
  "connectedPeers": [],
  "manifestVersion": 0,
  "fileCount": 0,
  "totalSize": 0,
  "lastSyncAt": 0,
  "pendingConflicts": 0
}
```

### 2. Full upload + commit + download cycle

```bash
echo -n "hello matrix os" > /tmp/sync-test.txt
HASH="sha256:$(shasum -a 256 /tmp/sync-test.txt | cut -d' ' -f1)"
SIZE=$(wc -c < /tmp/sync-test.txt | tr -d ' ')

# Get a presigned PUT URL
PUT_URL=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"files\":[{\"path\":\"sync-test.txt\",\"action\":\"put\",\"hash\":\"$HASH\",\"size\":$SIZE}]}" \
  http://localhost:4000/api/sync/presign \
  | jq -r '.urls[0].url')

# Upload directly to MinIO
curl -X PUT --upload-file /tmp/sync-test.txt "$PUT_URL"

# Commit (gateway updates the manifest)
VERSION=$(curl -s http://localhost:4000/api/sync/manifest | jq -r '.manifestVersion')
curl -s -X POST -H "Content-Type: application/json" -H "X-Peer-Id: laptop" \
  -d "{\"files\":[{\"path\":\"sync-test.txt\",\"hash\":\"$HASH\",\"size\":$SIZE}],\"expectedVersion\":$VERSION}" \
  http://localhost:4000/api/sync/commit

# Read back via presigned GET
GET_URL=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"files":[{"path":"sync-test.txt","action":"get"}]}' \
  http://localhost:4000/api/sync/presign \
  | jq -r '.urls[0].url')
curl -s "$GET_URL"
# → "hello matrix os"
```

### 3. Inspect MinIO contents

Browser: http://localhost:9101 (login: `matrixos` / `matrixos123`).

CLI:
```bash
docker run --rm --network 066-file-sync_default --entrypoint sh minio/mc:latest \
  -c "mc alias set local http://minio:9000 matrixos matrixos123 > /dev/null && mc ls --recursive local/matrixos-sync/"
```

### 4. Inspect manifest in Postgres

```bash
docker exec 066-file-sync-postgres-1 psql -U matrixos -d matrixos \
  -c "SELECT user_id, version, file_count, total_size FROM sync_manifests;"
docker exec 066-file-sync-postgres-1 psql -U matrixos -d matrixos \
  -c "SELECT id, owner_id, path, grantee_id, role, accepted FROM sync_shares;"
```

## Authenticating the CLI

Phase 9 wires real auth: the CLI fetches a JWT from the platform's OAuth
device flow, then the daemon presents it to the gateway.

### Production flow

```bash
node --import tsx bin/matrixos.ts login
# -> opens browser at https://platform.matrix-os.com/auth/device?user_code=BCDF-GHJK
# -> sign in with Clerk, click "Confirm"
# -> CLI prints "Logged in as @yourhandle"
```

The CLI persists `~/.matrixos/auth.json` (mode 0600, JWT inside) and writes
`~/.matrixos/config.json` with the `gatewayUrl` it discovered via
`GET /api/me`.

### Dev shortcut

For local Docker you don't need Clerk -- the gateway accepts any bearer
when `MATRIX_AUTH_TOKEN` is unset. Skip the device flow:

```bash
node --import tsx bin/matrixos.ts login --dev
```

This writes a stub `~/.matrixos/auth.json` with `accessToken: "dev-token"`.
After this you still need to set `gatewayUrl` in `~/.matrixos/config.json`
(the dev shortcut doesn't run the platform):

```json
{
  "platformUrl": "http://localhost:9000",
  "gatewayUrl": "http://localhost:4000",
  "syncPath": "/Users/you/matrixos-test",
  "peerId": "laptop"
}
```

### Pointing the CLI at the local platform

If you brought up the platform with `bun run docker:full`, override the
platform URL at login time:

```bash
node --import tsx bin/matrixos.ts login --platform http://localhost:9000
```

You can also persist it by adding `"platformUrl": "http://localhost:9000"`
to `~/.matrixos/config.json` -- subsequent `login` calls pick it up.

## Running the Sync Daemon

The sync daemon watches a local folder and syncs it bidirectionally with the
gateway.

```bash
# Start daemon syncing ~/matrixos-test
node --import tsx bin/matrixos.ts sync ~/matrixos-test

# Check status
node --import tsx bin/matrixos.ts sync status

# Pause / resume
node --import tsx bin/matrixos.ts sync pause
node --import tsx bin/matrixos.ts sync resume
```

The daemon uses `~/.matrixos/config.json` for its config and
`~/.matrixos/daemon.sock` for IPC. Logs land in `~/.matrixos/logs/sync.log`.

## Two-Peer Test (Same Machine)

Bring up the multi-user profile (alice + bob) and run two daemons against
two different gateways:

```bash
docker compose -f docker-compose.dev.yml --profile multi up -d

# Terminal 1: daemon for alice
MATRIXOS_CONFIG_DIR=~/.matrixos-alice \
  node --import tsx bin/matrixos.ts sync ~/matrixos-alice

# Terminal 2: daemon for bob
MATRIXOS_CONFIG_DIR=~/.matrixos-bob \
  node --import tsx bin/matrixos.ts sync ~/matrixos-bob

# Terminal 3: drop a file in alice's folder, watch it appear in bob's
echo "from alice" > ~/matrixos-alice/hello.txt
sleep 3
cat ~/matrixos-bob/hello.txt
```

(Currently the daemon hardcodes `~/.matrixos` as its config dir; respecting
`MATRIXOS_CONFIG_DIR` is a small pending change.)

## Installing the macOS Menu Bar App

Source: `packages/sync-client/macos/MatrixSync.xcodeproj`

### Option A: Build from Xcode

```bash
open packages/sync-client/macos/MatrixSync.xcodeproj
```

In Xcode: Product → Run (or `Cmd+R`). The app appears in the menu bar.

### Option B: Build from CLI

```bash
cd packages/sync-client/macos
xcodebuild -project MatrixSync.xcodeproj -scheme MatrixSync \
  -configuration Release -derivedDataPath ./build build

# Install to /Applications
cp -R ./build/Build/Products/Release/MatrixSync.app /Applications/
open /Applications/MatrixSync.app
```

### What the app shows

- **Menu bar icon**: spinning if syncing, checkmark if up-to-date, dashed
  circle if the daemon isn't running
- **Click the icon** to open the panel:
  - Sync state (Syncing / Paused)
  - File count and current manifest version
  - Last sync timestamp (relative)
  - Pause / Resume button
  - Refresh + Quit

### How it talks to the daemon

The app connects to `~/.matrixos/daemon.sock` over a Unix domain socket and
sends JSON commands (`{"command":"status"}`, `{"command":"pause"}`, etc.).
If the daemon isn't running, the app shows "Daemon not running" with a hint
to run `matrixos sync`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `[sync] Sync API disabled` in gateway logs | Missing S3 credentials | Check `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` env vars |
| Presigned PUT returns HTTP 000 (curl) | URL points at `minio:9000` (container hostname) | Check `S3_PUBLIC_ENDPOINT=http://localhost:9100` is set on the dev container |
| `relation "sync_manifests" does not exist` | Migration didn't run | Restart dev container -- migrations run on boot |
| Commit returns 409 `version_conflict` | Stale manifest version | Re-fetch manifest first, retry with new `expectedVersion` |
| `result.body.text is not a function` | AWS SDK v3 stream API mismatch | Already fixed -- use `transformToString("utf-8")` instead |
| macOS app shows "Daemon not running" but daemon is running | Socket path mismatch | Daemon writes `~/.matrixos/daemon.sock`; app reads same path. Check `~/.matrixos/daemon.pid` exists |
| Container env var changes not picked up | `restart` doesn't reload env | Use `docker compose up -d --force-recreate dev` instead |

## Useful References

- Sync routes: `packages/gateway/src/sync/routes.ts`
- R2/S3 client: `packages/gateway/src/sync/r2-client.ts`
- Manifest logic: `packages/gateway/src/sync/manifest.ts`
- Postgres adapters: `packages/gateway/src/sync/db-impl.ts`
- Daemon entry: `packages/sync-client/src/daemon/index.ts`
- IPC server: `packages/sync-client/src/daemon/ipc-server.ts`
- macOS app: `packages/sync-client/macos/MatrixSync/`
- Spec: `specs/066-file-sync/spec.md`
