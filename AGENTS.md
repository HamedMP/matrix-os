# AGENTS.md: Matrix OS

Matrix OS is **Web 4**: a unified AI operating system (OS + messaging + social + AI + games). Claude Agent SDK is the kernel. Everything persists as files. Reachable via web desktop, Telegram, WhatsApp, Discord, Slack, Matrix protocol. Vision: `specs/web4-vision.md`. Website: matrix-os.com

## Constitution

Read `.specify/memory/constitution.md`: the 10 core principles. **Re-read at the start of every session and after compaction** — the constitution is the source of truth for non-negotiable rules.

Key principles:

1. **Data Belongs to Its Owner**: files hold identity/config/export state; user/org app data lives in owner-controlled Postgres
2. **AI Is the Kernel**: Agent SDK V1 `query()` with `resume`, model-agnostic routing over time
3. **Headless Core, Multi-Shell**: core works without UI, shell is one renderer
4. **Defense in Depth (NON-NEGOTIABLE)**: auth matrix, input validation, resource limits, timeouts
5. **TDD (NON-NEGOTIABLE)**: tests first, 99-100% coverage target

## Tech Stack

- **Runtime**: Node.js 24+, TypeScript 5.5+ strict, ES modules
- **AI**: Claude Agent SDK V1 `query()` + `resume`, Opus 4.6
- **Frontend**: Next.js 16 (`proxy.ts` replaces middleware, Turbopack, React Compiler, `cacheComponents`), React 19
- **Backend**: Hono (HTTP/WS gateway + channel adapters)
- **Database**: PostgreSQL via Kysely for platform, kernel durable state, social, app, and user data. Do not add alternative embedded databases or ORMs for new persistence.
- **Validation**: Zod 4 (`zod/v4` import)
- **Testing**: Vitest, `@vitest/coverage-v8`
- **Package Manager**: pnpm (install), bun (run scripts) -- NEVER npm

## SDK Decisions (Spike-Verified)

- V1 `query()` with `resume`: V2 silently drops mcpServers, agents, systemPrompt
- `createSdkMcpServer()` + `tool()` for in-process MCP tools (Zod 4 schemas)
- `allowedTools` is auto-approve, NOT filter: use `tools`/`disallowedTools` to restrict
- `bypassPermissions` propagates to ALL subagents: use PreToolUse hooks for access control
- Agent SDK bundles its own claude runtime -- no separate install needed
- `bypassPermissions` refuses root -- Docker must run as non-root user
- Prompt caching: `cache_control: {type: "ephemeral"}` on system prompt + tools (90% savings)
- Integration tests use haiku (<$0.10 per run)

## Development Rules

- **TDD**: failing tests FIRST, then implement (Red -> Green -> Refactor)
- **Conventional Commits and PR Titles**: commits and PR titles use semantic Conventional Commit style such as `feat(canvas): add workspace canvas`; never prefix PR titles with agent/tool tags like `[codex]`.
- **Specs go in `specs/`**: NEVER `docs/plans/`. Format: `specs/{NNN}-{feature-name}/`
- **Kysely/Postgres only**: never add alternative embedded databases or ORMs for new persistence
- **Landing-adjacent UI uses `@matrix-os/brand`**: auth, onboarding, billing, provisioning, and related shell/www surfaces should consume tokens/primitives from `packages/brand/` instead of ad-hoc hex values or forked brand helpers
- **Kernel prompt**: keep under 7K tokens
- **Spike before spec**: test undocumented SDK behavior with throwaway code first
- **Large files are refactor debt**: aim for <500 LOC for composition entrypoints, containers, hooks, helpers, and focused tests. Treat 500-1000 LOC as a review smell that needs one clear responsibility; do not add behavior to 1000+ LOC files without an extraction plan, and split 2000+ LOC files before adding behavior. See `docs/dev/large-file-refactoring.md`.
- After major features: run `/update-docs` to sync all documentation

## Mandatory Code Patterns

These patterns were identified as recurring defects across 4+ PRs (~317 unresolved review comments). Violations are the #1 source of bugs. Full analysis: `docs/dev/pr-review-analysis.md`

### Atomicity

- **2+ related DB writes MUST use a transaction**. No exceptions. Like + counter, delete + cascade, insert + update are all multi-step.
- **Optimistic concurrency must be enforced in the write statement**. Pre-reading a revision inside a transaction is not enough under READ COMMITTED; include `WHERE revision = :baseRevision` on the `UPDATE` or take a row lock.
- **Use `ON CONFLICT` for idempotent upserts** instead of check-then-insert (TOCTOU race).
- **Unique-scope create flows must be idempotent server-side**. If a unique index defines the logical singleton, `INSERT ... ON CONFLICT ... DO NOTHING` and select the existing row; do not rely on a client pre-check.
- **Use `{ flag: 'wx' }` for exclusive file creates** instead of `existsSync` + `writeFile`.

### External Calls

- **Every `fetch()` to an external service MUST have `signal: AbortSignal.timeout(ms)`**. Default: 10s for APIs, 30s for file downloads. No external call may hang indefinitely.
- **Server-side fetches of user-controlled URLs must block SSRF**. Parse the URL, resolve DNS, and reject loopback, link-local, private, multicast, documentation, and internal ranges before calling `fetch()`.
- **Server-side fetches of user-controlled URLs must reject redirects** unless each redirected URL is revalidated. Use `redirect: "error"` for preview/health checks to avoid redirect-based SSRF.
- **DNS preflight is not DNS pinning**. If user-controlled server-side fetch remains hostname-based after validation, document the residual DNS-rebinding risk or use a dispatcher/agent that pins the resolved address.
- **Never expose provider names or raw error messages to clients**. Log the real error server-side, return a generic message. This includes Postgres errors, Twilio/ElevenLabs/OpenAI errors, and filesystem paths.

### Input Validation

- **Use Hono `bodyLimit` middleware** on every mutating endpoint. Never check Content-Length after the body is already buffered.
- **DELETE is a mutating endpoint**. It still needs `bodyLimit`, even when the route normally ignores request bodies.
- **Validate and sanitize all user-supplied values** before using in file paths, SQL identifiers, or API URLs. Use `resolveWithinHome` for paths, `SAFE_SLUG` regex for identifiers.
- **Validate URL path params and query params at the route boundary** with Zod schemas before calling services. This includes IDs embedded in paths (`nodeId`, `canvasId`), scope filters, cursors, limits, and search strings.
- **Action endpoints need per-action payload schemas**. Use a Zod discriminated union keyed by `type`; do not accept a generic record and cast `action.payload as ...` in the service.
- **No wildcard CORS** (`Access-Control-Allow-Origin: *`). Use explicit origin allowlist.

### Resource Management

- **Every in-memory Map/Set MUST have a size cap and eviction policy**. No unbounded growth. Cap + LRU eviction or TTL-based cleanup.
- **Realtime subscriber registries need stale-connection eviction**, not only `onClose` cleanup. Network partitions can skip close handlers; sweep by `lastTouched`/TTL before enforcing caps.
- **Realtime subscriber registries need explicit shutdown drains**. On server shutdown, notify/clear subscribers before destroying dependencies used by authorization or broadcast paths.
- **Every temp file MUST have a cleanup policy** (TTL, max count, or explicit deletion after use).
- **Temp cleanup must be symlink-safe and recurring**. Use `lstat()` when sweeping attacker-named files, skip symlinks, schedule periodic cleanup, and clear timers on shutdown.
- **Long-lived Postgres/Kysely resources must be destroyed on gateway shutdown**. If a repository wraps a pool or Kysely instance, add it to the close path.
- **Only owners close shared DB pools/connections**. Transaction-scoped or dependency-injected repository wrappers must not call `pool.end()`/`destroy()` for resources they did not create.
- **`appendFileSync`/`writeFileSync` are banned in request handlers**. Use async `fs/promises` to avoid blocking the event loop.

### Error Handling

- **No bare `catch { return null }`**. Every catch must check error type -- DB connection failures and timeouts are not "not found."
- **No `catch { }` (empty catch)**. At minimum, log the error.
- **Async store workflows must catch create/open/load failures at the orchestration boundary**. If a multi-step UI action creates data then opens/reloads it, set an error on any failed step and refresh summaries/cache when safe.
- **Misconfiguration is not not-found**. Missing server dependencies such as `homePath`, registries, provider config, or database handles should return a generic 5xx/503-style error, not a 404 that looks like user data is missing.
- **Do not throw raw `Response` objects from service/route helpers**. Use typed errors and one mapper so auth, validation, and server misconfiguration cannot masquerade as missing resources.
- **Client stores must allowlist/cap server error strings before showing them**. Even gateway-normalized errors can regress; UI state must fall back to a generic message for unknown, long, or provider/path/database-looking errors.
- **Health checks and reachability probes must return coarse booleans only**. Do not echo upstream status codes or provider/network details to clients after SSRF filtering.
- **Webhook handlers must return appropriate status codes** -- 200 only on success, 4xx/5xx on failure so providers retry correctly.
- **WebSocket broadcasts must isolate subscriber failures**. Wrap each per-subscriber send, log failures, and continue delivering to remaining subscribers.
- **WebSocket broadcasts must evict dead senders**. A failed send should remove that subscriber after the broadcast loop so future broadcasts do not retry known-dead sockets.
- **Async WebSocket subscription/auth setup must be awaited** before success messages are sent; failure paths should send a generic error best-effort and then close.
- **WebSocket message bodies need schema validation after JSON parsing**. Size and syntax checks are not enough; validate each frame type with bounded Zod schemas before storing or broadcasting payloads.

### Concurrency and UI State

- **Read-modify-write database operations must stay inside one transaction** or one targeted SQL update. Do not read outside a transaction and write inside a later transaction.
- **Single-entity JSONB patches should target the entity path when possible**. Avoid whole-document rewrites that conflict independent edits to different nodes/items; use `jsonb_set`/targeted SQL or document coarse locking and retry expectations.
- **Soft-deleted records should stay out of normal/export reads** unless the recovery/audit path explicitly documents why deleted data remains readable.
- **Delete paths should filter already-deleted records** (`deleted_at IS NULL`) so repeat deletes do not silently refresh tombstones and mask stale clients.
- **REST mutations that affect realtime documents must notify subscribers** after the write succeeds, using generic events that include the new revision and timestamp.
- **Browser WebSocket auth must support query-token paths explicitly**. Browsers cannot set `Authorization` headers on WebSocket upgrades; every authenticated browser WS route needs exact or pattern registration in the query-token allowlist.
- **Debounced saves must guard against active-document changes**. Conflict reloads should only reopen the document if it is still the active document when the save settles.
- **Debounced save conflicts must not silently discard optimistic local edits**. Keep the local document visible or provide explicit conflict resolution; do not replace user edits with the server version without a deliberate user action.
- **Destructive UI actions must catch request failures before clearing local state**. Delete/archive flows should only clear the active document after the server confirms success.
- **Export/download store actions need the same error handling as mutations**. Catch request failures, set safe error state, and return a null/error result instead of leaking unhandled rejections.
- **Shared client store state should be serializable** unless there is a strong reason otherwise. Prefer arrays or records over `Set`/`Map` in Zustand state.
- **Zustand selectors must not allocate fresh arrays/objects every render**. Select primitive/stable slices and derive filtered arrays with `useMemo` inside components.
- **Do not duplicate derived store logic in components**. Put shared filters/search derivations in a pure exported helper or store method, then reuse it from both tests/store and UI components.

### Wiring Verification

- **Every IPC tool must resolve its dependency at registration time**, not at call time. If a tool needs `callManager`, verify it's not `undefined` when the tool is registered.
- **Never use `globalThis` for cross-package communication**. Use dependency injection or typed IPC messages.
- **Read paths for persisted UI references must reconcile stale live-resource refs**. Terminal sessions, review loops, and similar runtime refs should be marked recoverable on main read paths instead of only during explicit recovery jobs.

## Setup

```bash
git clone https://github.com/hamedmp/matrix-os.git && cd matrix-os
flox activate        # provisions Node 24, pnpm 10, bun, git + runs pnpm install
bun run dev          # local source dev only; production runs on per-user VPS host services
```

Without Flox: install Node 24+, pnpm 10, bun manually, then `pnpm install`. Full guide: `docs/dev/onboarding.md`

## Project Structure

| Directory | What it is |
|-----------|------------|
| `packages/kernel/` | AI kernel -- Agent SDK, agents, hooks, SOUL, skills |
| `packages/gateway/` | Hono HTTP/WS gateway, channel adapters, cron |
| `packages/platform/` | Multi-tenant orchestrator (Clerk auth, per-user VPS provisioning and routing) |
| `packages/proxy/` | Shared API proxy, usage tracking |
| `packages/brand/` | Shared brand tokens/primitives consumed by `www` and shell auth/onboarding/billing UI |
| `packages/ui/` | Shared UI components |
| `shell/` | Next.js 16 desktop shell frontend |
| `apps/mobile/` | Expo/React Native mobile shell |
| `www/` | matrix-os.com website (Vercel) |
| `home/` | File system template (copied to `~/matrixos/` on first boot) |
| `specs/` | Architecture and feature specs |
| `tests/` | Vitest test suites |

## Running

```bash
bun run test              # unit tests
bun run test:watch        # Vitest watch mode
bun run test:integration  # integration tests (needs ANTHROPIC_API_KEY, uses haiku)
bun run test:coverage     # coverage report
bun run test:e2e          # end-to-end tests
bun run build:shell:production  # canonical production shell build (release-parity auth/shell build)
bun run build:desktop     # Electron desktop production build

bun run dev               # local dev: gateway + proxy + shell
bun run dev:gateway       # gateway only
bun run dev:shell         # shell only
bun run dev:mobile-shell  # browser shell forced into the mobile launcher/runtime
bun run dev:proxy         # proxy only
bun run dev:platform      # platform only
bun run dev:www           # matrix-os.com website only
bun run dev:kernel        # kernel package only
bun run dev:desktop       # Electron desktop shell

bun run docker            # Legacy/local Docker dev only; not production customer runtime
bun run docker:full       # + proxy, platform, conduit
bun run docker:all        # + observability stack
bun run docker:multi      # + alice & bob multi-user
bun run docker:stop       # stop containers, preserve volumes
bun run docker:restart    # restart dev container
bun run docker:logs       # tail dev container logs
bun run docker:shell      # shell into container as matrixos user
bun run docker:build      # full rebuild (no cache)
```

**IMPORTANT**: Production Matrix OS is VPS-native per user. Do not use Docker Compose, image rebuilds, or rolling container restarts as the customer runtime deployment path.
**IMPORTANT**: Always run `pnpm install` from the repo root after adding/removing dependencies to update `pnpm-lock.yaml`. Vercel deployments fail on stale lockfiles.
**Native mobile shell**: Expo Go is not a supported runtime. Use the Expo dev client: rebuild/install with `pnpm --filter matrix-os-mobile exec expo run:ios --device <device-udid-or-name>` after native/plugin changes, then run Metro with `pnpm --filter matrix-os-mobile exec expo start --dev-client --host lan --clear`. Full prerequisites, Clerk redirect setup, and terminal validation live in `docs/dev/mobile-shell.md`.

## Release Procedure

Production customer runtime ships as VPS-native host bundles. R2 stores immutable tarball bytes, platform Postgres stores release metadata and channel pointers, and each VPS keeps the installed release at `/opt/matrix/release.json`.

- **Package safety**: pnpm is pinned to 10.33.4 and `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (7 days). Keep `pnpm install --frozen-lockfile` in CI/release paths; do not bypass the lockfile or downgrade pnpm below 10.16.
- **Bundle object store split**: host-bundle publish/download flows now prefer dedicated `R2_BUNDLES_*` / `S3_BUNDLES_*` settings when present and fall back to the existing `R2_*` / `S3_*` sync store otherwise. Keep sync/user objects on the primary store; use `R2_BUNDLES_ENDPOINT` or `R2_ENDPOINT` for jurisdictional bundle buckets instead of repointing the sync bucket.
- **Main channel**: pushes to `main` run `.github/workflows/host-bundle-release.yml`, build a host bundle, register it in platform DB, and promote `dev` by default.
- **Tags**: `v*` tags build immutable release versions and promote `canary` by default. Promote `stable` only after live verification.
- **Manual release**: workflow dispatch can choose `dev`, `canary`, `beta`, or `stable`, plus severity/changelog. Security severity may auto-deploy.
- **Build-time env**: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`/`NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`, and `NEXT_PUBLIC_POSTHOG_API_HOST` are baked into the shell/www bundles. `NEXT_PUBLIC_POSTHOG_API_HOST` should stay the relative `/relay` same-origin proxy for client traffic; use `POSTHOG_HOST=https://eu.posthog.com` as the private API host for source-map uploads or PostHog API scripts.
- **PostHog alerts bootstrap**: `bun run observability:posthog-alerts` idempotently provisions the "Matrix OS Errors" dashboard plus the baseline exception/provisioning/billing/onboarding insights. Requires `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`; optional `POSTHOG_API_HOST` defaults to `https://eu.posthog.com`. Issue/spike alerts are still configured manually in the PostHog UI because there is no stable public API for them.
- **Incremental bundle metadata ships with every host bundle**: `./scripts/build-host-bundle.sh` now emits `dist/host-bundle/incremental-manifest.json` plus `dist/host-bundle/objects/sha256/*`, and `./scripts/publish-release.sh` / platform release registration must publish them alongside the full tarball. Platform serves `/system-bundles/<version>/incremental-manifest.json` and `/system-bundles/objects/sha256/<sha256>`, but `requiresFullBundle` remains `true` until the VPS-side delta installer is explicitly enabled.
- **User data invariant**: updates may replace `/opt/matrix/app` only. Never overwrite owner data under `$MATRIX_HOME` (`/home/matrix/home`), especially `system/desktop.json`, `system/theme.json`, `system/wallpapers/`, `system/icons/`, identity/profile/session/state files, logs, memory, or conversations. Template sync may add/upgrade OS-owned files, but protected user paths must be skipped.
- **Local emergency build**: `set -a; source .env; set +a; HOST_BUNDLE_VERSION=<version> HOST_BUNDLE_CHANNEL=<channel> MATRIX_BUILD_SHA=$(git rev-parse HEAD) MATRIX_BUILD_REF=main ./scripts/build-host-bundle.sh`.
- **Publish**: `./scripts/publish-release.sh <version> --channel <channel>` uploads `system-bundles/<version>/matrix-host-bundle.tar.gz` and `.sha256`, then registers release metadata through `/system-bundles/releases`.
- **Deploy**: trigger existing VPSes through platform with `POST /vps/deploy {"channel":"dev"}` or `{"version":"<version>"}`. Do not SSH-copy bundles except for break-glass recovery.
- **Verify**: for every VPS, check `/opt/matrix/app/BUNDLE_VERSION`, `/opt/matrix/release.json`, `matrix-gateway`, `matrix-shell`, `matrix-sync-agent`, and local health.
- **Feature test VMs**: for risky shell/onboarding/platform changes, prefer a disposable test VPS over the user's primary computer. Use the same Clerk login, switch via `https://app.matrix-os.com/runtime` or explicit `https://app.matrix-os.com/vm/<handle>`, deploy exact bundle versions, and ask the user whether to delete the test VM after validation to avoid extra Hetzner charges.
- **R2 cleanup**: old `system-bundles/*` versions may be deleted after the new version is published, deployed, and verified. Keep the currently promoted/live version and its `.sha256`; do not delete objects still referenced by active channel pointers or rollback plans.
- **Selected developer tools gate first readiness**: the post-payment Default installs step stores selected `codex`, `claude-code`, `opencode`, and `pi` tool IDs for provisioning, then first boot runs `matrix-developer-tools.service` before `matrix-gateway.service` registers the VPS as running. The systemd units must also enforce this ordering (`matrix-gateway.service` requires and starts after the completed developer-tools oneshot), and selected install failures must not background-retry past the readiness gate. Failures show up under `/var/lib/matrix-developer-tools/` (`*.log`, `failed-tools`, `installed-tools`) and should keep the machine in provisioning until retry/support resolves them. Manual terminal installs after provisioning still run visibly in the terminal.

## Customer Support Notes

- **Public repo boundary**: support docs in this repository must stay public-safe. Document product behavior, invariants, validation steps, and escalation boundaries; do not include customer identifiers, IPs, access tokens, hostnames tied to private incidents, billing IDs, or copy-paste commands that expose secrets. Keep private operator runbooks in the private support system or secret manager.
- **Machine resizing exists as a platform-internal support primitive**: `POST /vps/:machineId/resize` is protected by platform auth and is intended for support or platform automation, not direct customer UI use. It performs an in-place Hetzner `change_type` flow with graceful shutdown first, `upgrade_disk: false`, guarded `running -> resizing -> running` state, and stale resize reconciliation.
- **Resize compatibility is constrained by Hetzner disk rules**: local root disks cannot shrink. Treat same-or-larger local disk x86 moves as eligible; reject smaller-disk downgrades before shutting down the customer VPS. For current plan shapes, `cpx22 -> cpx32/cpx52` and `cpx32 -> cpx52` are valid, while `cpx32 -> cpx22` and `cpx52 -> cpx32/cpx22` are not safe unless a separate migration/storage architecture proves the root data fits.
- **Customer-facing plan changes are separate**: billing/Stripe may change a user's plan entitlement, but existing VPS resizing should remain support/platform-controlled until preflight compatibility checks and UX copy explicitly handle unsupported downgrades.

## Desktop Release Workflow

- **Desktop OTA channels include `dev`**: treat `dev`, `canary`, `beta`, and `stable` as first-class update channels. Unsigned prerelease packaging must omit empty mac signing env vars rather than exporting blank values.
- **mac artifact verification must be exact-name, not glob-based**: compute the version/artifact base once, then verify `Matrix-OS-${version}-mac-${arch}.{dmg,zip}` plus both `.blockmap` files and fail on unexpected extra mac artifacts.
- **mac CI must smoke-test the produced DMG**: mount the generated DMG with `hdiutil`, copy `Matrix OS.app` out with `ditto`, and verify the executable before upload/publish.
- **Prerelease mac manifests may be arch-only**: when a channel build does not emit `<channel>-mac.yml`, merge `arm64-mac.yml` + `x64-mac.yml` as the fallback manifest pair instead of failing the publish.
- **`desktop/electron-builder.yml` should not hardcode mac `arch:` arrays**: the workflow matrix `--arch` flag is the source of truth for which architecture each mac job builds.
- **Packaged desktop CSP must be main-process injected and gateway-scoped**: do not reintroduce a static renderer HTML CSP meta tag or broad `connect-src https: wss:` allowances. The packaged renderer policy must be injected from Electron with the resolved Matrix gateway origin.
- **Desktop auth callback is `matrixos://auth?status=approved`**: keep `matrix-os://device-auth` only as a legacy compatibility path, register both URL schemes, keep deep-link handling in the main process, and preserve cold-start deep-link handoff until a window exists. Only trusted native desktop clients (`matrix-os-desktop`, `matrix-os-macos`) may receive signed native redirects, and the legacy scheme must stay narrowed to `matrix-os://device-auth` with no query params. The deep link is only a focus signal; auth still completes via polling.

## Shell Gotchas

- **Canvas mode is the primary shell experience**: users may only see Canvas in the sidebar. Build and verify new shell features in Canvas first, then Desktop. Desktop compatibility still matters, but Canvas is the main product surface.
- **Do not borrow Developer chrome during desktop-mode hydration**: persisted `mode` can be restored before `_hydrated` flips true, so resolve launcher/dock chrome from the active mode rather than a pre-hydration Developer fallback. Otherwise Canvas users briefly lose Canvas-only controls like the launcher.
- **Wire built-ins in every renderer**: built-in app paths like `__workspace__`, `__terminal__`, `__file-browser__`, `__preview-window__`, and `__chat__` must be handled in both `Desktop.tsx` and `canvas/CanvasWindow.tsx`. Never let `__...` paths fall through to `AppViewer`, because that turns them into `/files/__...` 404s.
- **Terminal launches must use the canonical built-in path**: route setup/manual/project terminal opens through `__terminal__`. Do not invent alternate built-in paths such as `__terminal__:setup`, because only the registered Terminal surface participates in shared launch/restore behavior across renderers.
- **Terminal agent installs must stay visible and use the runtime node prefix**: the Terminal `+` menu checks `/api/agents`; when an agent is missing it should open a new tab that runs a direct `npm install -g --prefix "$MATRIX_NODE_PREFIX"` command with `MATRIX_NODE_PREFIX` defaulting to `/opt/matrix/runtime/node`. Do not hide these installs in the background or switch the UI back to `matrix-install-tool-pack`.
- **Terminal theme scope is split**: Terminal chrome theme (`appThemeId`) is terminal-local UI state, while shell color theme persists through the global terminal preferences endpoint backed by `system/shell-preferences/terminal-global.json`. Do not wire the Terminal theme menu to the global Matrix OS shell theme or back into per-session preference files.
- **Transient shell overlays must share one notification host**: use the shared `ShellNotificationStack` / `ShellNotificationPortal` path for connection status, runtime identity, onboarding errors, VocalPanel errors, and similar top-right shell toasts. Do not mount competing fixed stacks at the same viewport anchor.
- **Shell z-index order is centralized**: reuse shared `SHELL_Z_INDEX` values and keep ordinary app-window z-order compacted below Settings. Do not scatter ad-hoc Tailwind `z-[...]` classes that can drift above Settings, hard gates, or the shell notification stack.
- **Canonical shell sessions live in `/api/terminal/sessions` across shells**: the web Terminal, macOS Terminal tab, and desktop Command Palette should all use the same named shell-session model instead of separate workspace-local session lists.
- **Shell session creation is rate-limited, not count-capped**: browser zellij sessions no longer enforce a hard live-session ceiling. If creation starts failing, inspect the shared creation rate limiter across `/api/terminal` and legacy `/api` mounts before reintroducing a `maxSessions` cap.
- **Canvas and Desktop share state**: window/app paths, layout persistence, dock pins, app icons, and restore/focus behavior must work in both modes. Add tests around shared helpers when possible, and manually check Canvas mode first for user-visible shell changes.
- **Never mutate state in reducers**: `reduceChat` etc. must create new objects via spread, not mutate in-place. Shallow copies share refs; mutating causes streaming text duplication.
- **Never use `meta.icon` as an iframe/app image URL**: shell icons resolve through `/icons/{slug}.png`, which falls back to shipped `.svg`/`.png` files in `home/system/icons/`; every manifest icon must have a matching shipped asset.
- **Default apps are Vite apps**: first-party apps under `home/apps/**` should use `runtime: "vite"` with `build.output: "dist"`. Do not add plain static HTML default apps; run `node scripts/build-default-apps.mjs home/apps` before bundling.
- **Default app manifest icons must be shipped icons**: every `home/apps/**/matrix.json` `icon` value must have a matching `.png` or `.svg` in `home/system/icons/`. Games use the shared `game-center` icon unless a concrete shipped icon exists. Keep `tests/gateway/apps.test.ts` passing so new users and VPS restores start with deterministic icons and do not fall into Gemini icon-generation loops.
- **Never cache-bust with `?t=Date.now()`**: use ETag-based `?v={etag}` only when file changes
- **Reset `imgFailed` when `iconUrl` changes**: track prev URL with `useRef`, reset on differ
- **Cloudflare overrides `Cache-Control`**: use `CDN-Cache-Control` header to control Cloudflare independently
- **PostHog client traffic must stay first-party**: shell and `www` should send analytics through the same-origin `/relay` rewrite, not `/ingest`, `neo.matrix-os.com`, or direct `*.posthog.com` client hosts. Keep legacy `/ingest` rewrites only for already-shipped cached bundles.
- **Shell replay kill switch is runtime-sensitive**: `POSTHOG_DISABLE_REPLAY=1` plus a `matrix-shell` restart disables shell replay without a rebuild; `NEXT_PUBLIC_POSTHOG_DISABLE_REPLAY` is build-time only. Keep `ph-no-capture` on terminal, chat, and file-browser surfaces, and do not enable shell console-log recording.
- **Production is VPS-native only**: user-facing Matrix OS runs on one VPS per user with host systemd services. Do not use Docker image rebuilds, `docker compose`, or rolling container restarts as the production rollout path for customer runtime.
- **No per-handle subdomains**: users reach their runtime through session-based routing on `app.matrix-os.com` (Clerk JWT -> customer VPS) or explicit `app.matrix-os.com/vm/<handle>` paths. `<handle>.matrix-os.com` URLs are not supported -- never generate, route, or assume them (`neo.matrix-os.com` is the PostHog proxy Worker, not a user). See `docs/dev/vps-deployment.md`.
- **Pre-VPS billing/auth/settings shell changes need platform/app-shell deployment**: before a user has an active VPS, routes like `/auth/device`, `/sign-in`, `/sign-up`, `/runtime`, and the billing-locked Settings/Billing UI are served by the platform-owned `app.matrix-os.com` shell surface, not by a customer VPS host bundle. When changing `shell/` or `packages/platform/` code that affects CLI device signup, Clerk auth, runtime selection, checkout, billing plan/region selection, provisioning, or account/sign-out controls visible before VPS creation, merge the PR and redeploy the platform/app-shell service that serves `app.matrix-os.com`; then verify the no-VPS flow directly. If the agent is not running on the Godfather/control VPS or lacks platform deploy credentials, it must tell the user to run that platform/app-shell deployment there and explain that a host-bundle publish will not update this pre-VPS screen. Do not stop after publishing a host bundle unless the user already has a provisioned Matrix computer.
- **Pre-VPS auth fallback assets must be platform-self-contained**: signed-out or no-VPS auth pages render before any customer runtime or shell asset route exists. Keep default-install cards, agent logos, and similar auth-fallback visuals inline or platform-served; do not depend on customer VPS or shell asset URLs there.
- **Customer VPS shell/gateway changes need host-bundle rebuild + publish**: per-user VPSes do not use the Docker user image. Run `set -a; source .env; set +a; ./scripts/build-host-bundle.sh`, publish `dist/host-bundle/matrix-host-bundle.tar.gz` and `.sha256` to `system-bundles/$CUSTOMER_VPS_IMAGE_VERSION/`, then refresh existing VPSes in place and restart `matrix-gateway.service`, `matrix-shell.service`, and `matrix-code.service`.
- **Hermes state is owner-local under `MATRIX_HOME`**: customer VPSes now canonicalize Hermes data at `/home/matrix/home/.hermes` via `HERMES_HOME`; legacy `/home/matrix/.hermes` is only a compatibility symlink. When changing `distro/customer-vps/host-bin/matrix-owner-env` or service launchers, preserve `matrix_reconcile_owner_home`, pass the reconcile owner/group through migrations, and guard new owner-env helpers with `declare -F` so older bundles degrade gracefully instead of crashing.
- **Pipedream stays platform-owned**: never put `PIPEDREAM_*` secrets on customer VPSes. VPS gateways need `PLATFORM_INTERNAL_URL` plus their existing `UPGRADE_TOKEN`/`MATRIX_HANDLE` so `/api/integrations*` proxies to platform-owned routes.
- **Never publish a shell bundle with the example Clerk key**: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is baked at host-bundle build time. If production logs show `clerk.example.com`, the served shell bundle was built with the placeholder key and must be rebuilt and redeployed.
- **Canvas panning must be target-gated**: wheel/pointer pan handlers should only accept events from the canvas surface/zoom overlay, not bubbled events from selected app windows. Add regression tests for scrolling inside an active app window.

## UX Guide

Read `specs/ux-guide.md`. Key rules:

1. Canvas-first: primary shell workflows must work in Canvas mode before Desktop mode.
2. Toggle consistency: click to open, click same spot to close. Light dismiss. Escape.
3. No layout shift: transient panels overlay, never push content.
4. Spatial memory: window positions persist across reloads.
5. Progressive disclosure: clean defaults, details one click away.
6. Empty states are onboarding: icon + headline + description + CTA.

## Spec Quality Gates

Every spec with endpoints/WebSockets/IPC/file I/O must include: security architecture (auth matrix, input validation, error policy), integration wiring (startup sequence, cross-package comms), failure modes (timeouts, concurrent access, crash recovery), resource management (buffer limits, file cleanup). Full checklist: `specs/quality-gates.md`

## Code Review Pipeline

Full guide: `docs/dev/review-pipeline.md`. Use three structured passes, not line-by-line review.

### Pre-PR Checklist (mandatory)

```bash
bun run typecheck           # tsc --noEmit for all packages
bun run check:patterns      # CLAUDE.md pattern scanner (scripts/review/check-patterns.sh)
bun run test                # unit tests
npx react-doctor@latest     # audit React code — REQUIRED when any React (.tsx/.jsx) file changed
```

**React audit (mandatory for React changes)**: whenever you create or modify React
files (`.tsx`/`.jsx` in `shell/`, `home/apps/**`, `packages/ui/`, `www/`), run
`npx react-doctor@latest <project-dir>` and resolve its findings **before committing**.
react-doctor scans a **project directory that has a React `package.json`** (e.g.
`npx react-doctor@latest shell`), NOT individual files. Root-toolchain default apps under
`home/apps/**` have no `package.json`, so audit them by copying `src/` into a temp dir with a
minimal React `package.json` and running react-doctor there. See
https://github.com/millionco/react-doctor. CI runs this on the project dirs of changed React files.

**Production shell build gate**: when a PR changes `shell/`, shell-facing `packages/platform/`, or CI wiring for the auth shell, run `bun run build:shell:production`. This is the canonical production build command, matches release tooling, and `CI Results` now blocks on the `Shell Production Build` job.

**Focused test reruns**: if `bun run test -- <path>` or `pnpm run test -- <path>` ignores the file filter and fans out into a broad repo run, fall back to `pnpm exec vitest run <path>` (or `pnpm exec vitest <path>` for watch mode) after the usual prerequisite builds are up to date.

**Agent CLI matrix changes need cross-surface sync**: if you add, remove, or rename a supported coding agent, keep `packages/platform/src/developer-tools.ts`, `shell/src/components/terminal/terminal-agent-options.ts`, `shell/src/components/terminal/TerminalApp.tsx`, `distro/customer-vps/host-bin/matrix-install-tool-pack`, `tests/platform/agent-install-matrix.ts`, `.github/workflows/agent-install-smoke.yml`, and the user docs aligned. The scheduled smoke path currently exercises `npm,pnpm,bun,yarn`.

**Screenshot evidence (mandatory for frontend-facing changes)**: every PR that changes
user-visible UI, visual styling, layout, frontend copy, app surfaces, or screenshots must include
a current screenshot or short screen recording of the changed state. Prefer capturing it directly
from the coding-agent environment with Playwright/browser tooling after running the relevant
stack. If the agent cannot run the surface locally, it must ask the developer to run the stack and
provide the screenshot before treating the frontend work as review-ready. For auth-gated shell UI,
a bypassed local shell run such as `E2E_TEST_BYPASS=1 NEXT_PUBLIC_E2E_TEST_BYPASS=1 ...` can help
capture routes like `http://localhost:3002/?launch=__terminal__`, but missing current Canvas/Desktop/mobile
evidence still blocks review-readiness. Do not rely on verbal descriptions for visual changes when
a screenshot is practical.

**Mobile shell gates**: if a PR touches `apps/mobile/` or shared terminal/mobile shell behavior, follow `docs/dev/mobile-shell.md`. Minimum local gates: `pnpm --dir apps/mobile exec jest --runInBand`, `pnpm --dir apps/mobile exec tsc --noEmit`, the relevant `bun run test` shell/gateway suites listed in that doc, and real-device validation before treating the change as review-ready.

### Three Review Passes

1. **Mechanical CLAUDE.md sweep**: Run `bun run check:patterns` and fix all violations. The scanner checks: bare catch, fetch without signal, sync file I/O, unbounded Map/Set. Warnings (bodyLimit, path ops, external headers) require manual verification.

2. **Trust-boundary sweep**: For each changed file, classify it (route handler, filesystem, database, WS/IPC) and apply the matching checklist from `docs/dev/review-pipeline.md`. Trace external input from entry to use.

3. **Atomicity/failure-mode review**: For each subsystem touched, answer: What is the source of truth? What is inside the lock/transaction? What happens on partial failure? What happens on shutdown? What is explicitly deferred?

### PR Size Limits

- **> 3000 additions or > 50 files**: split the PR
- Split along: gateway, platform, sync-client, shell, docs/deploy
- For multi-slice features, prefer Graphite stacked PRs over one oversized PR.
  Follow `docs/dev/stacked-prs.md`: initialize with `gt init`, create each
  layer with `gt create --all --message "<conventional commit>"`, update
  layers with `gt modify --all` or `gt modify --commit --all --message`,
  restack with `gt restack`, sync with `gt sync`, publish with
  `gt submit --stack` or `gt ss -np`, and open the stack with `gt pr`.
  Prefer Graphite commands over raw git/gh equivalents for stack operations.
  If `gt` is missing or unauthenticated, treat that as an environment blocker
  for stack work instead of silently falling back. Do not flatten a stack unless
  explicitly asked.

### PR Body: Mandatory Invariants

Every backend PR must include an "Invariants" section:

- **Source of truth**: which store is canonical, how divergence is reconciled
- **Lock/transaction scope**: what is inside the critical section, are network calls inside or outside
- **Acceptable orphan states**: what happens if step N+1 fails after step N succeeds
- **Auth source of truth**: primary auth mechanism, fallback behavior
- **Deferred scope**: what is explicitly NOT in scope -- say so, don't leave dead code

### CI Timeouts

- **Timeouts must cover observed runtime with margin**. If a CI job completes all tests successfully but is canceled by `timeout-minutes`, raise or split the job instead of treating it as a product test failure.
- **Screenshot jobs are expensive and often stall on browser install**. If the `Screenshots` workflow hangs, first check whether it is stuck at `pnpm exec playwright install chromium`; Playwright docs note browser cache restore can be as slow as download on Linux. For headless-only screenshot tests, prefer `pnpm exec playwright install --only-shell chromium`. For non-visual PRs, use the `skip-screenshots`/`no-screenshots` label or cancel optional screenshot runs rather than blocking a release.

### Branch Freeze

Do not request review while still pushing commits. Either declare a review commit range or mark the PR as ready and stop pushing.

### Hard Rules (never violate)

- **All changes ship via PR from a manual `git worktree`** -- no direct commits to `main`, no exceptions. Create the worktree with `git worktree add -b <kebab-branch> ../<dir-name> origin/main` and do all work there. Applies to code AND docs.
- **No PR merge until Greptile reports 5/5** -- every finding must be fixed in the diff or explicitly deferred in the PR body with a linked follow-up issue.
- **Do not spam Greptile re-review comments** -- Greptile is configured to review every new commit. If the score/footer is stale after a push, it means the review is still running; wait and poll instead of repeatedly mentioning it.
- No bare `catch {}` or `.catch(() => {})` -- every catch must check error type and log
- No `fetch()` without `signal: AbortSignal.timeout()` -- 10s APIs, 30s downloads
- No `writeFileSync`/`appendFileSync` in request handlers -- use `fs/promises`
- No unbounded `Map`/`Set` without size cap and eviction
- No `path.join()` on unvalidated external input -- use `resolveWithinPrefix`
- No raw error messages or Zod `.issues` in client responses
- No PR larger than 3000 additions or 50 files without splitting
- **Run `npx react-doctor@latest` before committing any React (`.tsx`/`.jsx`) change** and resolve its findings — CI enforces this on PRs touching React files (https://github.com/millionco/react-doctor)

### Shell App Data Contract (default apps under `home/apps/**`)

Apps run inside a **sandboxed `srcdoc` iframe with `origin: null`** and CSP `connect-src 'self'`.
- **Never** call `fetch()` to `/api/bridge/*` or any URL directly from app code — blocked by CORS + CSP.
- **Never** rely on `localStorage` in the shell — it throws `SecurityError` in the sandbox (guarded test-only fallback is fine).
- Use the injected `window.MatrixOS` bridge for everything: `db.*` (Postgres), `readData`/`writeData` (KV), `service`/`integrations`, and `proxyFetch(url)` for allowlisted external GETs.
- `AppViewer` loads runtime apps **only** via the bridged `srcDoc`; do not reintroduce a plain `src=/apps/{slug}/` load (it runs un-bridged and breaks data access).

## Deferred Work (TODO)

- **Hidden shell Settings sections (paid-beta scope)**: the **Agent, Channels, Skills, Security, Cron, and Plugins** Settings pages are hidden from the shell Settings nav via `HIDDEN_SECTION_IDS` in `shell/src/components/Settings.tsx`. Only **Appearance, Integrations, Billing, System** are exposed for now. The section components and their render branches are intentionally left intact — re-enable a page by removing its id from `HIDDEN_SECTION_IDS`. **TODO before unhiding**: finish/redesign each surface (content, copy, empty states, error handling) and add coverage. Track per-section follow-ups in the backlog.

## Reference Docs

Read these on demand, not every session:

- `ARCHITECTURE.md` and root `DOMAIN.md` (if present) -- when changing package ownership, cross-package imports, or domain boundaries; if a package/context has its own `ARCHITECTURE.md` / `DOMAIN.md`, read the nearest relevant docs before moving code
- `docs/dev/review-pipeline.md` -- when reviewing or opening PRs (three-pass structure, checklists, CI gates)
- `docs/dev/stacked-prs.md` -- when splitting a feature into Graphite stacked PRs
- `docs/dev/onboarding.md` -- developer setup, API keys, and getting started
- `docs/dev/mobile-shell.md` -- when working on the Expo/native mobile shell, physical-device testing, or terminal resume controls
- `docs/dev/pr-review-analysis.md` -- when triaging review comments or understanding recurring defect patterns
- `docs/dev/docker-development.md` -- when working on Docker setup or debugging container issues
- `docs/dev/vps-deployment.md` -- when deploying to production or managing the VPS
- `docs/dev/preview-environments.md` -- when a change needs to be seen running: per-PR preview VPSes (`preview-vps` label), platform preview revisions, HMR staging slots, and centralized log queries via `scripts/preview-logs.sh`
- `docs/dev/releases.md` -- when tagging a release or managing versions
- `specs/quality-gates.md` -- when writing a new spec or reviewing a PR
- `specs/ux-guide.md` -- when working on shell/frontend UI
- `.specify/memory/constitution.md` -- re-read at the start of every session and after compaction (10 core principles, source of truth for non-negotiable rules)

## Swarm / Multi-Agent Rules

- **NEVER use Agent-tool `isolation: "worktree"`** -- that parameter creates an ephemeral worktree that discards uncommitted changes. This is distinct from the required **manual `git worktree add`** workflow (see Hard Rules), which is the canonical way every change ships.
- **Agents MUST commit progress** after each phase/feature
- **NEVER call TeamDelete** -- team files are cheap, lost work is expensive
- Sub-agents spawned for parallel exploration share the parent's worktree; they must commit before exiting.

## Active Technologies
- TypeScript 5.5+ strict, ES modules, Node.js 24+, React 19, Next.js 16 + Hono, Zod 4 via `zod/v4`, Kysely/Postgres for user app/workspace data, existing terminal stack (`node-pty`, `@xterm/xterm`), `@tldraw/tldraw` for the shell canvas renderer (071-tldraw-workspace-canvas)
- User-owned Postgres workspace tables for canonical canvas documents and references; filesystem export/backup integration under `~/system/` or project export bundles where required by recovery flows (071-tldraw-workspace-canvas)
- TypeScript 5.5+ strict, ES modules, Node.js 24+ + Hono gateway, Hono WebSocket support, node-pty, zod/v4, citty, ws, Node child_process/fs/promises/path/crypto APIs, zellij 0.44.1 pinned in Docker images (068-zellij-cli)
- Files under the owner-controlled Matrix home (`~/system/shell-sessions.json`, `~/system/layouts/*.kdl`) plus local CLI files under `~/.matrixos/profiles.json` and `~/.matrixos/profiles/<name>/` (068-zellij-cli)
- TypeScript 5.5+ strict, ES modules, Node.js 24+ + Hono gateway, Hono WebSocket support, Zod 4 via `zod/v4`, existing `jose` JWT validation, Vitest (072-request-principal)
- No new persistence; request principal is request-scoped. Existing consumers continue to use owner-controlled PostgreSQL/Kysely and sync R2/object storage through existing repositories. (072-request-principal)
- TypeScript strict, ES modules, Node.js 24+ for gateway; React 19, React Native 0.83, Expo Router 55 for mobile shell + Hono gateway, Zod 4 via `zod/v4`, existing terminal stack (`node-pty`, `@xterm/xterm` on web), Expo Router, React Native WebView, Clerk Expo, AsyncStorage/SecureStore (075-mobile-shell)
- Owner-controlled Matrix home files for shell/terminal session metadata (`~/system/terminal-sessions.json`, terminal layout files) plus existing owner Postgres where current workspace/app data already lives. No new embedded database or ORM. (075-mobile-shell)
- TypeScript 5.5+ strict, ES modules, Node.js 24+, React 19, Next.js 16 + Hono gateway routes, Zod 4 via `zod/v4`, Kysely/Postgres, Matrix homeserver appservice support, self-hosted Telegram and WhatsApp bridge runtimes, existing Matrix OS shell/app bridge, Hermes/Claude Agent SDK V1 `query()` path (077-matrix-messaging-bridge)
- Owner-local Postgres on the customer VPS for Matrix OS permission/audit data; separate homeserver database; separate Telegram bridge database; separate WhatsApp bridge database; owner-local media/cache paths covered by backup/restore policy (077-matrix-messaging-bridge)
- TypeScript 5.5+ strict, ES modules, Node.js 24+, React 19, Next.js 16 shell/platform, Hono gateway + Hono, Zod 4 via `zod/v4`, Kysely/Postgres, existing onboarding WebSocket, existing Symphony routes, existing integrations registry/Pipedream proxy, existing terminal stack, lucide-react, Playwright/Vitest, always-on Hermes with Claude/Codex augmentation, Finna-inspired admin/control surface patterns (082-paid-beta-readiness)
- Owner-controlled Postgres/Kysely for readiness, integration capability, agent action, admin/control activity, company context, and audit data; owner home files for inspectable onboarding completion/profile/config exports under `~/system/`; no new embedded database or ORM (082-paid-beta-readiness)
- TypeScript 5.9+, strict mode, ES modules; runtime target Node.js 24+ + Existing sync-client CLI, gateway shell routes, Hono, Zod 4, native Fetch/FormData/Blob, existing `ws` attach transport (106-terminal-rich-paste)
- Owner-controlled filesystem under Matrix home for paste assets; no new database persistence (106-terminal-rich-paste)

- TypeScript 5.5+ strict, ES modules + node-pty (backend), @xterm/xterm + addon-webgl + addon-search + addon-serialize + addon-fit (frontend), Hono WebSocket (gateway), Zod 4 (validation) (056-terminal-upgrade)
- Files — `~/system/terminal-sessions.json` (session metadata), `~/system/terminal-layout.json` (layout with sessionId) (056-terminal-upgrade)

## Recent Changes

- 106-terminal-rich-paste: Planned attached CLI rich paste for local image paths and observable clipboard image pastes, with owner-scoped gateway paste assets and safe prompt rewriting.
- 077-matrix-messaging-bridge: Planned owner-controlled Matrix messaging bridge for Telegram and WhatsApp first, with homeserver/appservice spike gates, per-room Hermes permissions, and separate owner-local bridge/homeserver/permission storage.
- 056-terminal-upgrade: Added TypeScript 5.5+ strict, ES modules + node-pty (backend), @xterm/xterm + addon-webgl + addon-search + addon-serialize + addon-fit (frontend), Hono WebSocket (gateway), Zod 4 (validation)

## Agent skills

### Canonical Matrix skill pack

- `skills/matrix/` is the source of truth for Matrix-hosted coding-agent skills. Do not hand-maintain duplicate Matrix skill copies under `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, or `$HERMES_HOME/skills`.
- Sync the canonical pack into Matrix, Claude Code, Codex, and Hermes discovery paths with `MATRIX_SKILL_TARGETS=matrix,claude,codex,hermes ./scripts/sync-matrix-agent-skills.sh skills/matrix`.
- Installers for the shipped pack are `./scripts/install-agent-matrix-skills.sh` and `./scripts/install-hermes-matrix-skills.sh`. `tests/platform/matrix-agent-skills-sync.test.ts` keeps the shipped `skills/matrix/*` directories aligned with those installers.
- Codex should read Matrix-managed skills from `~/.agents/skills`; `scripts/sync-matrix-agent-skills.sh` cleans stale Matrix-managed entries from the legacy `~/.codex/skills` path so they do not shadow the canonical location.

### Matrix CLI agent bootstrap

- Preferred developer bootstrap commands are:

```bash
matrix login
matrix run -it -- claude
matrix run -it -- codex
matrix run -it --session setup -- gh auth login
matrix shell connect -c setup
```

- `matrix run -it` starts a zellij-backed Matrix shell session and attaches the local terminal over `/ws/terminal`; use named sessions such as `setup` when multiple humans/agents may need to reattach the same VPS context.
- `matrix login` may stay open while the browser completes signup, trial checkout, and provisioning; approve the CLI in that same browser tab once the instance is ready. For local dev, `matrix login --profile local` or `matrix login --dev` skips the device flow and writes the local dev stub token.
- Keep auth flows separate: use browser/device approval for `matrix login`, then run `gh auth login` inside the Matrix terminal session for GitHub browser auth. Do not ask users to upload local private SSH keys into Matrix; Matrix-managed SSH keys live on the VPS.
- Prefer `matrix shell connect` over `matrix shell attach`. `matrix shell connect -c <session>` is the create-if-missing path.
- If `matrix run -it`, `matrix shell new`, or `matrix shell attach` fails with `zellij_failed`, run `matrix shell ls` and connect to an existing session instead of retrying the same create path.

### Stack review monitor

- For existing Graphite stacks, prefer the repo command in `.claude/commands/monitor-stack-reviews.md`: `/monitor-stack-reviews <pr-or-range-or-branch>`.
- That command owns the review gate for stack fixes: current-head Greptile `5/5`, no unresolved human/Codex review blockers, `ready-for-ci` applied only after that review state, then CI monitoring.
- Treat missing `gt`/`gh` auth, running outside the intended manual worktree, stale Greptile reviews that do not match the current head SHA, or missing `ready-for-ci` repository label as blockers. Do not fall back to ad-hoc branch surgery or manual label churn.

### Backlog

GitHub Issues at `HamedMP/matrix-os`. See `docs/agents/backlog.md`.

### Triage labels

Five canonical roles using default label names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.

<!-- SPECKIT START -->
Current Spec Kit plan: `specs/106-terminal-rich-paste/plan.md`.
<!-- SPECKIT END -->
