# Spec 066 File Sync — Deployment Plan

Incremental rollout of the three-way file sync system (Phase 9 OAuth + Phase 10 three-way sync + Mac app + distribution). Designed so production backend can be updated first and validated locally before the client pieces ship, minimising blast radius if anything regresses.

## Principles

- **Server ships before client.** PR 1 (server + R2) lands first and is validated in isolation. PR 2 (new CLI) is built against the upgraded prod. Since there are currently zero CLI users in the wild, backward compat with older CLIs is NOT a concern for PR 1 — we get a clean break. From PR 2 onward, each shipped CLI must continue to work against subsequent backend PRs.
- **Single rollout domain.** All HTTP + WebSocket traffic terminates at `app.matrix-os.com` / `matrix-os.com`. No new subdomains.
- **Clerk userId is the source of truth.** R2 keys, manifest rows, and JWT claims all key off `claims.sub`. Handle is cosmetic.
- **Each user keeps their own container.** Platform proxies `app.matrix-os.com` → `matrixos-<handle>:{3000,4000}` based on Clerk session → container lookup. Nothing in this plan merges users into a shared gateway.
- **Every PR is independently revertable.** No PR depends on a later PR to function.

## Current Production Topology (for context)

```
                      DNS
                        |
                   matrix-os.com
                   app.matrix-os.com
                   <handle>.matrix-os.com   (legacy; still routed)
                        |
                        v
             +-------------------------+
             |   platform (Hono)       |   packages/platform/src/main.ts
             |   - Clerk verify        |
             |   - /api/auth/device/*  |   packages/platform/src/auth-routes.ts
             |   - orchestrator        |   Hetzner API: start/stop container
             |   - reverse proxy       |   -> matrixos-<handle>:3000 / :4000
             +-------------------------+
                        |
                        v  (Docker network)
           +-------------------------------+
           |   per-user Hetzner container  |
           |   - gateway (Hono) :4000      |   packages/gateway/src/server.ts
           |     - /api/sync/* + /ws       |
           |     - home-mirror             |   packages/gateway/src/sync/home-mirror.ts
           |   - shell (Next.js) :3000     |   shell/
           +-------------------------------+
                        |
                        +--> Cloudflare R2  (matrixos-sync bucket)
                        |
                        +--> Postgres      (sync_manifests + sync_shares)
```

Local dev mirrors the container half via `docker-compose.dev.yml`. Platform + proxy are only relevant in prod.

---

## PR 1 — Backend + Identity + R2 wiring (ship to prod first)

**Goal**: prod has everything the new CLI will need — Clerk identity on the server side, Cloudflare R2 provisioned and wired into every per-user container, and a session-based gateway URL. No data exists yet in prod, so no migration or legacy-fallback concerns.

### Decisions locked before starting

1. **"No account" UX** — when `matrix login` succeeds Clerk auth but `/api/me` returns 404, print a friendly "sign up at https://app.matrix-os.com first" message. (CLI-side signup lands in PR 4.)
2. **First-sync UX** — daemon polls the manifest after login until `manifestVersion > 0`, with a "Waiting for your Matrix instance…" progress message. Timeout 120s, then instruct user to check `app.matrix-os.com` that their container is running.
3. **No data migration** — prod has zero sync users; fresh-start on new Clerk-userId-prefixed bucket. If any stray handle-prefixed keys exist in Cloudflare R2, wipe them manually in the dashboard.
4. **No legacy CLI fallback** — zero existing CLIs in the wild. `getUserId` switches cleanly to `claims.sub` with no handle path.
5. **Cloudflare R2 directly** (not MinIO-in-prod). One shared `matrixos-sync` bucket, shared access key injected into every per-user container by the Platform orchestrator. Prefix isolation enforced at the gateway (`buildFileKey(userId, …)`). Per-user scoped R2 tokens = hardening follow-up, not blocker.

### Scope

- **F15 — Clerk userId as bucket prefix**. Gateway's `getUserId` returns `claims.sub` (e.g. `user_2abc...`) instead of `MATRIX_HANDLE` env var. `buildFileKey` + `sync_manifests.user_id` switch to the same. Handle stays as a purely cosmetic field (logs, menu bar display).
- **Cloudflare R2 provisioning**. New bucket `matrixos-sync`, API token scoped to it, credentials in Hetzner `.env`. Details in `docs/dev/vps-deployment.md` § "Sync Storage (Cloudflare R2)".
- **Orchestrator env-var injection**. `packages/platform/src/main.ts` pushes `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE=false`, `MATRIX_HOME_MIRROR=true` into `extraEnv` so every per-user container boots with sync storage wired up. Same pattern as the existing `CLERK_SECRET_KEY` / `GEMINI_API_KEY` injection at `main.ts:626–641`.
- **Device approval UI lives on `app.matrix-os.com`**. Platform exempts `/auth/device*` and `/api/auth/device/*` paths from the container-proxy step. The Clerk-embedded approval page served directly by platform (current raw HTML is fine for PR 1).
- **Bi-directional broadcast in `home-mirror.ts`**. Push path calls `peerRegistry.broadcastChange` after `writeManifest` (already on branch).
- **Subscribe-to-changes in `home-mirror.ts`**. Mirror registers itself as a virtual peer; broadcasts from laptop commits pull into the container's home (already on branch).
- **Drop username subdomain dependency in `gatewayUrlForHandle`**. Returns `https://app.matrix-os.com` for every handle. `GATEWAY_URL_TEMPLATE` env override kept intact for dev.
- **Friendly "no account" branch in `login.ts`**. On `/api/me` 404, print the sign-up hint and exit 0 without writing auth.json.
- **Poll-for-manifest loop in daemon**. After login, before starting chokidar, GET `/api/sync/manifest` in a 2s-backoff loop until `manifestVersion > 0` or 120s elapsed. Each iteration prints one dot; on timeout print a clear error pointing to `app.matrix-os.com`.

### Files touched

```
packages/gateway/src/server.ts                 # getUserId from JWT sub (claims.sub)
packages/gateway/src/sync/routes.ts            # getUserId helper: same
packages/gateway/src/sync/home-mirror.ts       # push broadcast + subscribe (already on branch)
packages/platform/src/main.ts                  # extraEnv gets S3_* + MATRIX_HOME_MIRROR
packages/platform/src/main.ts                  # /auth/device* path exempt (find the container-proxy branch)
packages/platform/src/auth-routes.ts           # gatewayUrlForHandle -> https://app.matrix-os.com
packages/sync-client/src/cli/commands/login.ts # friendly "no account" message on /api/me 404
packages/sync-client/src/daemon/index.ts       # poll-for-manifest before chokidar
docs/dev/vps-deployment.md                     # new "Sync Storage (Cloudflare R2)" section
tests/gateway/sync/home-mirror.test.ts         # already on branch
tests/gateway/sync/user-id-from-jwt.test.ts    # NEW -- assert getUserId returns claims.sub
```

### Deploy steps (run from the VPS)

These assume a working deployment per `docs/dev/vps-deployment.md`. The VPS agent does steps 2–10.

1. **Local only**: merge PR 1 to `main`, tag `v0.4.0-rc1`.
2. On VPS: `cd /root/matrix-os && git fetch --tags && git checkout v0.4.0-rc1`.
3. **Cloudflare R2 setup** (first-time only — skip if already done on this account):
   - In Cloudflare dashboard → R2 → Create bucket `matrixos-sync` (default location).
   - R2 → Manage R2 API Tokens → Create API Token with permissions *Object Read & Write* scoped to the `matrixos-sync` bucket. Copy the `Access Key ID` and `Secret Access Key`. Note the `S3 API` endpoint URL — it looks like `https://<account-id>.r2.cloudflarestorage.com`.
4. Append to `/root/matrix-os/.env`:
   ```
   S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   S3_PUBLIC_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   S3_ACCESS_KEY_ID=<access-key-from-step-3>
   S3_SECRET_ACCESS_KEY=<secret-key-from-step-3>
   S3_BUCKET=matrixos-sync
   S3_FORCE_PATH_STYLE=false
   ```
   (R2 supports virtual-host addressing, so `S3_FORCE_PATH_STYLE=false`. Dev still uses `true` because MinIO requires it.)
5. Rebuild the user-container image (R2 wiring is runtime, but the home-mirror code is baked in):
   ```bash
   docker build \
     --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
     -t matrixos-user:local \
     -f Dockerfile .
   ```
6. Rebuild + restart platform so it picks up the new `extraEnv` vars:
   ```bash
   docker compose -f distro/docker-compose.platform.yml --env-file .env up -d --build platform
   ```
7. Roll every user container so they re-launch with the new env:
   ```bash
   curl -X POST http://localhost:9000/containers/rolling-restart \
     -H "Authorization: Bearer $PLATFORM_SECRET"
   ```
8. Verify the env reached a container:
   ```bash
   CANARY=$(docker ps --filter "name=matrixos-" --format "{{.Names}}" | head -1)
   docker exec $CANARY env | grep -E '^(S3_|MATRIX_HOME_MIRROR)='
   # Expect: all six S3_* vars + MATRIX_HOME_MIRROR=true
   ```
9. Run the smoke tests below.
10. Watch logs for 10 minutes: `docker compose -f distro/docker-compose.platform.yml logs -f platform | grep -E '(error|ERROR|sync)'`.

### Smoke tests

Run from your laptop against `https://app.matrix-os.com`. Have at least one Clerk-authenticated account with a provisioned container (`$HANDLE` below).

```bash
# 1. /auth/device renders (exempt from container proxy)
curl -sI https://app.matrix-os.com/auth/device?user_code=TEST-1234
# Expect: 200, Content-Type: text/html

# 2. /api/auth/device/code works (exempt from container proxy)
curl -sX POST -H 'content-type: application/json' \
  -d '{"clientId":"smoke-test"}' \
  https://app.matrix-os.com/api/auth/device/code
# Expect: 200, {deviceCode, userCode, verificationUri, expiresIn, interval}

# 3. Container's home-mirror uploaded seed files to R2
CANARY=$(docker ps --filter "name=matrixos-" --format "{{.Names}}" | head -1)
docker exec $CANARY sh -c 'wget -qO- http://localhost:4000/api/sync/manifest -H "Authorization: Bearer $MATRIX_AUTH_TOKEN" | head -c 500'
# Expect: non-empty JSON with manifestVersion >= 1 and files object populated

# 4. Bucket prefix really is Clerk userId. Use `rclone` or the Cloudflare dashboard:
#    R2 > matrixos-sync > Objects.
# Expect: top-level prefixes look like `user_2abc.../files/...` (Clerk ids), not handles.

# 5. End-to-end matrix login + sync (do this from your laptop, not the VPS)
matrix login           # device flow, browser approve
matrix sync ~/matrixos-smoke
# Expect: "Waiting for your Matrix instance..." for a few seconds, then pulls files.
ls ~/matrixos-smoke    # expect agents/, system/, .claude/ etc.

# 6. Three-way round-trip
docker exec $CANARY sh -c 'echo "from container" > /home/matrixos/home/smoke.md'
# Wait 5s. On laptop:
cat ~/matrixos-smoke/smoke.md
# Expect: "from container"
echo "from laptop" > ~/matrixos-smoke/smoke.md
# Wait 5s. In container:
docker exec $CANARY cat /home/matrixos/home/smoke.md
# Expect: "from laptop"

# 7. Friendly "no account" UX. Pick a fresh machine with no Clerk account:
matrix login
# After device approval fails (or from a Clerk account with no container):
# Expect: "No Matrix instance yet. Sign up at https://app.matrix-os.com first."
```

### Rollback

- No migration, no irreversible data changes. Rollback = `git checkout v0.3.x && docker compose up -d --build` + remove the S3_* vars from `.env`.
- R2 bucket can be wiped via Cloudflare dashboard if needed; nothing else depends on it yet.

### Done criteria

- All seven smoke tests pass.
- No `NoSuchKey`, `AccessDenied`, or `SignatureDoesNotMatch` errors in gateway logs for 24h.
- Cloudflare R2 dashboard shows objects under Clerk-userId prefixes.
- Grafana `sync_files_synced_total` counter increments on test edits.

### Stretch (optional inside PR 1 or split to PR 1b)

- Rebuild the device approval UI in shell (`shell/src/app/auth/device/page.tsx`) using shadcn components. Calls platform `/api/auth/device/approve` via Next.js route handler.
- Per-user scoped R2 tokens (one token per Clerk userId, prefix-limited). Hardening win; not needed for v1.

---

## PR 2 — Client UX + Mac App

**Goal**: new CLI + Mac app, pointing at PR 1's prod backend.

### Scope

- **`gatewayFolder` plumbing (F1)** — replaces basename-as-prefix with explicit config. `matrix sync --folder <name>` opts into scoped mode; default is full mirror. `packages/sync-client/src/daemon/remote-prefix.ts`.
- **`matrix login` writes `gatewayUrl: https://app.matrix-os.com`** by default. `--dev` override for localhost flows.
- **Daemon IPC extensions**: `getConfig`, `setSyncPath`, `setGatewayFolder`, `restart`, `logout` so the Mac app Settings view can drive config changes.
- **Mac app Settings view** (`SettingsView.swift`): identity (peer/gateway/log out), sync folder picker, gateway scope field, "Add to Finder Sidebar" fallback. Opens via `SettingsLink` / ⌘,.
- **FinderSync extension** (`MatrixSyncFinderSync.appex`): per-file badges (synced / pending / error) driven by `~/.matrixos/sync-state.json`. Ships embedded in `MatrixSync.app/Contents/PlugIns/`.
- **tsx loader CWD-independent fix** in `bin/matrixos.mjs` + daemon launcher — makes `matrix` work from any directory after `pnpm link --global` / a packaged install.

### Files touched

```
packages/sync-client/src/daemon/remote-prefix.ts            # NEW
packages/sync-client/src/daemon/index.ts                    # gatewayFolder + IPC
packages/sync-client/src/cli/commands/sync.ts               # --folder flag
packages/sync-client/src/cli/commands/login.ts              # default gatewayUrl
packages/sync-client/macos/MatrixSync/SettingsView.swift    # NEW
packages/sync-client/macos/MatrixSync/MenuBarView.swift     # Settings menu item
packages/sync-client/macos/MatrixSync/SyncStatusModel.swift # IPC helpers
packages/sync-client/macos/MatrixSyncFinderSync/*           # NEW .appex target
packages/sync-client/macos/MatrixSync.xcodeproj/project.pbxproj
bin/matrixos.mjs                                             # tsx loader fix
packages/sync-client/src/daemon/launcher.mjs                 # same
tests/gateway/sync/home-mirror.test.ts                       # coverage
packages/sync-client/tests/unit/remote-prefix.test.ts        # NEW
```

### Deploy steps

No server deploy for this PR — purely client.

1. Merge PR 2 to `main`.
2. Tag a release: `git tag v0.2.0 && git push --tags`.
3. CI builds + signs + notarises `MatrixSync.app` (see PR 3 for pipeline); attaches to the GitHub release.
4. Users update via PR 3 channels (`brew upgrade matrix`, re-run installer, etc).

### Smoke tests

On a fresh machine:

```bash
# 1. Install works (once PR 3 ships a release channel)
curl -sL get.matrix-os.com | sh

# 2. Login round-trip
matrix login
# Browser: app.matrix-os.com/auth/device?user_code=XXXX-XXXX
# Click Confirm (Clerk session must be active). CLI should print:
#   Logged in as @yourhandle
#   Gateway: https://app.matrix-os.com

# 3. First sync materialises the container home
matrix sync ~/matrixos
ls ~/matrixos     # expect agents/, system/, .claude/, ...

# 4. Live edits round-trip in both directions (see PR 1 smoke test 5)

# 5. Mac app
open /Applications/MatrixSync.app
# Menu bar icon appears. Open Settings (⌘,). Verify sync path, scope,
# peer id, gateway URL are correct.

# 6. Finder badges
open ~/matrixos
# System Settings -> Login Items & Extensions -> Finder Extensions ->
# toggle "MatrixSync Finder Integration" on. Badges appear on files.

# 7. Settings writes work
# In Settings -> Sync Folder: change path, click Save & Restart.
# Confirm daemon picks up new path (matrix sync status shows the new path).
```

### Rollback

Local: `brew uninstall matrix` + delete `/Applications/MatrixSync.app` + `~/.matrixos/`. Users can reinstall a prior version from the GitHub releases page.

### Done criteria

- All 7 smoke tests pass on a clean macOS 15+ install.
- No new errors in Sentry (once wired) during first 48h of user installs.

---

## PR 3 — Distribution (installer + brew + npm)

**Goal**: users can install with one command.

### Scope

- **npm package `@matrix-os/cli`** — publish the CLI via pnpm workspace. Bin: `matrix`, `matrixos`.
- **Homebrew tap `matrix-os/tap`** — formula that wraps the npm install for now (bundled standalone binary later).
- **macOS `.pkg` installer** — bundles `matrix` CLI + `MatrixSync.app` + FinderSync extension. Signed with Developer ID Application + Installer certs, notarised via `notarytool`. Post-install script: register the Finder extension with `pluginkit`, optionally launch the menu bar app.
- **`get.matrix-os.com/install.sh`** — detects platform:
  - macOS: downloads the signed `.pkg`, runs `installer -pkg`
  - Linux: `npm i -g @matrix-os/cli` (fallback until we have standalone linux binary)
  - Windows: PowerShell branch (later)
- **CI pipeline**: `.github/workflows/release.yml` — on tag push, runs tests, builds + signs + notarises the Mac installer, publishes npm, uploads artefacts to the GitHub release, refreshes the Homebrew tap.

### Files touched

```
packages/sync-client/package.json              # bin, files, publishConfig
scripts/build-macos-pkg.sh                      # NEW
scripts/notarise-macos.sh                       # NEW
scripts/install.sh                              # NEW -- served at get.matrix-os.com
.github/workflows/release.yml                   # NEW
homebrew-tap/Formula/matrix.rb                  # NEW, lives in a separate repo
```

### Deploy steps

1. Provision Apple Developer ID Application + Installer certs (one-time).
2. Store cert p12 + App Store Connect API key as GitHub Actions secrets.
3. Merge PR 3.
4. `git tag v0.2.0 && git push --tags` triggers the release workflow.
5. Workflow publishes npm, uploads signed `.pkg` to the GitHub release, commits updated formula to `matrix-os/homebrew-tap`.
6. Smoke-test the install script on a fresh macOS VM:

```bash
curl -sL get.matrix-os.com | sh
which matrix && matrix --version
ls /Applications/MatrixSync.app
```

### Rollback

- Unpublish from npm (within 72h only — after that, deprecate to a known-good version).
- Delete the GitHub release artefacts.
- Revert the Homebrew formula to the prior version.

### Done criteria

- One-liner works on macOS 14+ and Ubuntu 22.04+.
- App + extension pass `spctl --assess -vv --type exec` (Gatekeeper approved).
- `brew install matrix-os/tap/matrix` installs and runs.

---

## PR 4 — Signup from CLI (future, non-blocking)

**Goal**: `matrix login` on a fresh machine can create a new Matrix account + container, not just authenticate an existing one.

### Proposed UX

```
$ matrix login
Welcome to Matrix OS.
  [1] I already have an account
  [2] Create a new Matrix instance
> 2

Email:            hamed@example.com
Pick a handle:    hamed

Creating your Matrix instance...
  Clerk user created
  Hetzner container provisioned (Frankfurt, nbg1-cx22)
  Home directory seeded

Select packages to install (space to toggle, enter to confirm):
  [x] claude-code       -- Claude Code integration
  [x] hermes            -- Hermes agent
  [ ] moltbot           -- Multi-channel messenger bot
  [ ] ...

Installing...
  claude-code
  hermes

Ready.
  Syncing to ~/matrixos
  Menu bar app launched
```

### Scope

- CLI interactive prompt with `@inquirer/prompts` (already in the workspace for other tools).
- Non-interactive variant: `matrix onboard --email ... --handle ... --packages claude-code,hermes`.
- Platform endpoint: `POST /api/signup` — creates the Clerk user server-side (Clerk backend API) and provisions the Hetzner container via the existing orchestrator.
- Package registry: a `~/system/packages.json` manifest the gateway reads on first boot and installs into `/home/matrixos/home/agents/` + `~/system/apps/`.
- Package selection backed by a central registry (initially a static JSON at `app.matrix-os.com/api/packages/catalog`).

### Reasons to split it out

- Signup changes the Clerk + orchestrator integration surface significantly — biggest risk in the plan.
- Needs its own spec (input validation, abuse prevention, quota policy) before coding starts.
- File sync can ship and be dogfooded without it; existing users sign up via `app.matrix-os.com` today.

Write the spec as `specs/067-cli-signup/spec.md` when PRs 1–3 are live and stable.

---

## Continuing to Build

Once PRs 1–3 are shipped, the next highest-value work lives in `specs/066-file-sync/follow-ups.md`:

### Short list (P0 remaining after PRs 1–3)

- **F3 — Hash-skip verification**. Confirm the daemon's "skip if same hash" logic after the remote-prefix refactor. Low effort, high regression-prevention value.
- **F16 — Commit batching**. Single biggest quality-of-life win — `home-mirror.pushFile` and the daemon's `onEvent` coalesce near-simultaneous edits into one commit, dropping manifest version churn by 10-100x. See follow-ups.md for design.
- **F6 — Initial-pull concurrency + progress**. A fresh container with thousands of files takes minutes to materialise on the laptop. Parallel downloads + 100-file progress log.

### Medium (P1)

- **F10 — Three-way conflict handling**. `node-diff3` infra exists in `packages/gateway/src/sync/conflict.ts` but isn't invoked. Wire it into both the gateway commit path and the daemon's push.
- **F17 — File Provider Extension**. Gets us the "Locations" sidebar section like Google Drive/Dropbox. Multi-day refactor; write a dedicated spec first (`specs/068-file-provider/spec.md`).
- **F8 — Self-heal stale manifest references**. Run a startup sweep that drops manifest entries with no R2 backing. Prevents `NoSuchKey` log spam after a bucket reset.

### Long (P2)

- **F9 — Secret-file deny list**. Expand `DEFAULT_IGNORE_PATTERNS` in `home-mirror.ts` to cover `*.pem`, `id_rsa*`, `*.token`, `.credentials.json`, and parse `.syncignore` in the gateway. Prevents accidental leaks via sync.
- **F12 — `matrix doctor` sync diagnostics**. Extend `runDoctor` with daemon status, last sync, peer count.
- **F13 — `matrix logs`**. Pretty-print `~/.matrixos/logs/sync.log` (pino JSON) through `pino-pretty`.

### Architecture-level

- **PR 4 — Signup from CLI** (above).
- **Clerk cookie cross-subdomain config** (referenced as TODO in `main.ts:290-306`). Unblocks the previously-disabled `<handle>.matrix-os.com` auth check. Only needed if the handle-subdomain routing is kept alive for backwards compat; can be deleted if not.
- **Gateway HA**. Currently one container = one gateway = one daemon. A restart drops WS connections. Moving to a per-user queue (NATS, Redis Streams) between home-mirror and the WS fan-out decouples availability from daemon liveness.

---

## Test Matrix

| Concern                       | PR 1 | PR 2 | PR 3 |
|-------------------------------|------|------|------|
| Existing client keeps working | ✓    | —    | —    |
| New client against new backend| —    | ✓    | ✓    |
| Fresh install flow            | —    | —    | ✓    |
| Three-way sync round-trip     | ✓    | ✓    | ✓    |
| Finder badges + Settings      | —    | ✓    | ✓    |
| Bucket prefix is Clerk userId | ✓    | ✓    | ✓    |
| No platform.* subdomain       | ✓    | ✓    | ✓    |

Track progress via a GitHub issue per PR and link to this doc.
