# Spec 063: React App Runtime

**Status**: Draft
**Created**: 2026-04-12
**Depends on**: 038 (App Platform foundation — process manager stubs), 050 (App Data Layer)
**Blocks**: 060 (Default Apps — all new apps built against this runtime)
**Constitution alignment**: I (Everything Is a File — source code on disk), III (Headless Core), IV (Defense in Depth), VI (App ecosystem)

## Problem

The current app runtime is iframe-only and serves a single `index.html` per app (`shell/src/components/AppViewer.tsx:149-158`, `home/apps/*/index.html`). There is no build step, no server-side apps, no TSX, no React component ecosystem access. The 11 default apps total ~12K lines of hand-written inline HTML/CSS/JS. The quality ceiling is capped because:

- Every app reinvents routing, state, layout, and design primitives
- No access to the React library ecosystem (@tanstack/react-query, framer-motion, recharts, @dnd-kit, etc.)
- No TypeScript type safety inside apps
- No way to build full-stack apps with API routes, server actions, or SSR
- AI authoring is stuck emitting a single HTML blob per app instead of idiomatic component code

Spec 038 declared support for `runtime: "node"` apps with process management and reverse proxy, but Phase A (T1400-T1409) was never implemented. This spec owns that work and extends it with a dedicated Vite mode optimized for static React builds.

## Goals

1. Three app runtimes coexist: `static` (raw HTML, current), `vite` (React SPA, built to `dist/`, statically served), `node` (long-running process, reverse-proxied — Next.js is the blessed framework but anything speaking HTTP on `$PORT` works)
2. AI agents author Vite + React apps as standard projects (`pnpm create vite`, `src/App.tsx`, `pnpm build`)
3. Gateway process manager handles spawn, idle shutdown, crash recovery, port allocation
4. Build orchestrator runs `pnpm install && pnpm build` on install and on source change, caches by lockfile + source hash
5. Shared pnpm store keeps disk usage bounded (content-addressable dedupe)
6. App store publishing ships source + pre-built `dist/`; install supports trusted (copy pre-built) and verified (rebuild + hash compare) paths
7. Resource limits per app (memory, CPU shares, file handles)
8. Compatible with existing `runtime: "static"` apps — nothing breaks

## Non-Goals

- Python/Rust/Docker runtimes (spec 038 listed them; this spec focuses on JS/TS)
- Auto-upgrade of existing default apps — quality pass happens under spec 060
- HMR/dev mode for end users (dev mode is a developer flag only, not a default; scoped out to a follow-up spec)
- Sandboxing beyond container-level limits — see spec 025 for stronger isolation
- WebAssembly runtime — future work
- Cross-origin app isolation — apps still run under the shell origin for bridge access

## Architecture Overview

### Runtime modes

| Mode | matrix.json `runtime` | Build output | Runtime process | Dispatcher behavior for `/apps/:slug/*` |
|---|---|---|---|---|
| Static | `"static"` | — (source is output) | none | serves files from `~/apps/{slug}/`; `/` rewrites to `/index.html` |
| Vite SPA | `"vite"` | `~/apps/{slug}/dist/` | none | serves files from `~/apps/{slug}/dist/`; `/` rewrites to `/index.html` |
| Node server | `"node"` | `~/apps/{slug}/.next/` or `dist/` | long-running child process | reverse-proxies HTTP + WS to `http://127.0.0.1:{port}/…` |

**All three modes share a single URL prefix: `/apps/:slug/*`.** The gateway mounts one dispatcher middleware that reads the manifest, picks a branch, and handles the request. AppViewer does not construct different URLs per mode — the URL is always `/apps/:slug/` and `runtimeState` decides between rendering the iframe or an error card.

Next.js is a `runtime: "node"` app with conventional `build` + `start` commands. The runtime does not hardcode Next; it is just the blessed template (see `home/agents/skills/build-next-app.md`).

**Why one prefix (motivation for the architecture choice):**
- One cookie path (`Path=/apps/{slug}/`) covers every request the iframe makes — HTML, JS, CSS, API. No second cookie for static assets.
- Changing an app's runtime mode (e.g. migrating a static app to Vite, or wrapping a Vite app in Next.js) is a one-field manifest edit. No URL changes, no iframe src changes, no broken bookmarks.
- The reverse-proxy threat surface is simpler: one middleware chain (`authMiddleware` → `appSessionMiddleware` → `dispatcher`) instead of two parallel routes with their own auth stories.
- The existing generic `/files/*` route (`server.ts:1397`) stays for arbitrary file browsing but stops being used for iframe navigation. Nothing else in the repo depends on `/files/apps/...` — it is a thin path the shell happens to construct today.

### Request flow

```
Browser -> AppViewer iframe -> /apps/{slug}/
                             -> gateway app-runtime dispatcher (Hono)
                             -> [static mode]  filesystem read from ~/apps/{slug}/
                             -> [vite mode]    filesystem read from ~/apps/{slug}/dist/
                             -> [node mode]    reverse-proxy to http://127.0.0.1:{port}
                                                (child process: Next.js / Hono / Express / whatever)
```

WebSocket upgrades (`/apps/{slug}/ws`, `/_next/webpack-hmr` in dev mode) are forwarded transparently by the dispatcher in node mode, and rejected with `400` in static/vite mode.

## matrix.json Schema Extension

```json
{
  "name": "Fancy Chart",
  "slug": "fancy-chart",
  "description": "Sales dashboard with live charts",
  "category": "productivity",
  "icon": "bar-chart",
  "author": "hamed",
  "version": "1.2.0",

  "runtime": "vite",
  "runtimeVersion": "^1.0.0",
  "scope": "personal",

  "listingTrust": "first_party",

  "build": {
    "install": "pnpm install --frozen-lockfile",
    "command": "pnpm build",
    "output": "dist",
    "timeout": 120,
    "sourceGlobs": ["src/**", "public/**", "*.config.*", "index.html", "matrix.json"]
  },

  "serve": {
    "start": "pnpm start",
    "healthCheck": "/api/health",
    "startTimeout": 10,
    "idleShutdown": 300
  },

  "resources": {
    "memoryMb": 256,
    "cpuShares": 512,
    "maxFileHandles": 128
  },

  "permissions": ["network", "data:read", "data:write"],
  "storage": { "tables": { /* spec 050 */ } }
}
```

Rules:
- `build` required for `vite` and `node`, absent for `static`
- `serve` required for `node`, absent for `static` and `vite`
- `runtimeVersion` is a semver range; platform refuses apps requesting a runtime it cannot provide
- `resources` has platform defaults (256 MB / 512 shares / 128 FDs) if omitted
- `scope` defaults to `"personal"`; forward-compat for spec 062 shared apps
- `listingTrust` defaults to `"first_party"` (local author); spec 058 overwrites this at publish time with a gallery-signed value. Runtime treats an absent value as `"community"` when the app arrives via an install bundle that did not come from a trusted gallery delivery (defense in depth against missing metadata)
- **`distributionStatus` is NOT an authored manifest field.** The Zod schema rejects it if present in the file. It is computed server-side on every read by `computeDistributionStatus(listingTrust, sandboxCapabilities())` and attached to the runtime response envelope (see §Shell Changes). This prevents a community-tier app from self-declaring `installable` to bypass the gate.
- Zod schema lives in `packages/gateway/src/app-runtime/manifest-schema.ts`, validated at install and on every load

## Process Manager

**Location**: `packages/gateway/src/app-runtime/process-manager.ts`

**Responsibilities:**
- Maintain a bounded `Map<appSlug, ProcessRecord>` of running child processes (cap = 10, LRU eviction)
- Allocate ports from a pool (range: 40000-49999)
- Spawn child processes via `child_process.spawn` with a restricted env whitelist
- Health check by polling `http://127.0.0.1:{port}{healthCheck}` on startup (up to `startTimeout` seconds)
- Track `lastUsedAt` per app, shut down idle apps after `idleShutdown` seconds
- Crash detection (exit with nonzero while `state === "running"`): restart with exponential backoff (1s / 4s / 16s), max 3 retries, then mark `failed`
- Graceful shutdown on gateway stop (SIGTERM with 5s grace → SIGKILL)

**Lifecycle states:**
```
idle -> starting -> healthy -> running -> stopping -> idle
                 \-> startup_failed
         running -> crashed -> restarting -> healthy
                            \-> failed (after max retries)
```

`idle` is the resting state — no child, no port held, record may be evicted from the map. `healthy` is a short-lived transition after a successful health check that immediately advances to `running`. `stopping` covers both idle-timeout shutdown and explicit stop; the reaper transitions to `idle` once the child is reaped.

**ProcessRecord:**
```typescript
type ProcessState =
  | "idle"             // no child; next ensureRunning will spawn
  | "starting"         // spawn issued, awaiting health check
  | "healthy"          // health check passed (transient, advances to running)
  | "running"          // serving requests
  | "stopping"         // SIGTERM sent, awaiting exit (idle timeout or explicit stop)
  | "crashed"          // child exited nonzero while running; restart scheduled
  | "restarting"       // backoff timer running before respawn attempt
  | "startup_failed"   // first-time spawn failed health check; no retries
  | "failed";          // exceeded restart budget; manual intervention required

interface ProcessRecord {
  slug: string;
  state: ProcessState;
  pid: number | null;
  port: number | null;                 // null while idle or between restarts
  startedAt: number;
  lastUsedAt: number;
  restartCount: number;
  lastError?: { code: string; stderrTail: string };
  child: ChildProcess | null;
  startupPromise: Promise<void> | null; // shared across concurrent callers during starting
}
```

This is the authoritative state enum for this spec. Tests, reverse-proxy state checks, and the manifest API runtime-state field all derive from `ProcessState`.

**Atomic spawn:**
1. Acquire process slot (LRU evict if at cap)
2. Allocate port from pool
3. Insert `ProcessRecord` in `state: "starting"` BEFORE spawning (prevents race between two concurrent `ensureRunning` callers)
4. Spawn child with `{ cwd: ~/apps/{slug}, env: safeEnv(slug, port) }` (env whitelist below)
5. Poll health check with `AbortSignal.timeout(startTimeout * 1000)`; fail if no 2xx within budget
6. On healthy: transition to `healthy` → `running`, resolve `startupPromise`
7. On any failure: stop child, release port, transition to `startup_failed` or `failed`, reject `startupPromise`

**Env whitelist (`safeEnv`):**
```typescript
{
  PORT: String(port),
  NODE_ENV: "production",
  HOME: `~/apps/${slug}`,
  PATH: minimalPath,
  MATRIX_APP_SLUG: slug,
  MATRIX_APP_DATA_DIR: `~/data/${slug}`,
  MATRIX_GATEWAY_URL: "http://127.0.0.1:4000",
  // NO CLAUDE_API_KEY, NO CLERK_SECRET, NO DB_URL beyond per-app
}
```

Child processes MUST NOT inherit gateway secrets. Per-app DB credentials are fetched from spec 050 app data layer.

## App-Runtime Dispatcher (`/apps/:slug/*`)

**Location**: `packages/gateway/src/app-runtime/dispatcher.ts`

**Single handler for all three runtime modes.** Mount order in `server.ts`: `authMiddleware` (delegates to `appSessionMiddleware` for `/apps/`) → `appSessionMiddleware` (cookie verify) → `mountAppRuntimeDispatcher` (runtime mode switch).

**Responsibilities:**
- Hono handler matching `/apps/{slug}/*`
- Validate slug with `SAFE_SLUG` regex before any filesystem or process-manager access
- Load manifest via `loadManifest`; dispatch on `manifest.runtime`:
  - `static` → serve files from `~/apps/{slug}/` via the existing `/files/*` helper, scoped via `resolveWithinHome`
  - `vite` → serve files from `~/apps/{slug}/dist/` via the same helper
  - `node` → look up `ProcessRecord` by slug; if missing or not running, `await processManager.ensureRunning(slug)`; forward HTTP to `http://127.0.0.1:{port}/*` preserving method, body, and sanitized headers
- Handle WebSocket upgrades in `node` mode only; return `400 ws_not_supported` for `static` and `vite`
- Update `lastUsedAt` on every request (node mode)
- Apply `AbortSignal.timeout(30000)` to backend fetches — no hang-forever (per CLAUDE.md external-call rule)
- On backend error: log server-side with full detail, return generic 502 with correlation ID (per CLAUDE.md error-exposure rule)
- Strip backend `Server:`, `X-Powered-By:` headers to avoid leaking provider info
- Strip every client-controlled forwarded header (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `X-Matrix-App-Slug`) and set canonical values from gateway config (`X-Forwarded-Host = cfg.publicHost`, `X-Forwarded-Proto = "https"`, `X-Forwarded-Prefix = /apps/{slug}`)
- Enforce Hono `bodyLimit` (10 MB default) before forwarding

**Request rewriting (node mode):**
- Client request: `GET /apps/fancy-chart/api/posts`
- Forwarded as `GET /api/posts` to `http://127.0.0.1:{port}`
- Next.js apps set `basePath: "/apps/fancy-chart"` in their generated `next.config.js` so absolute asset URLs match

## Build Orchestrator

**Location**: `packages/gateway/src/app-runtime/build-orchestrator.ts`

**Responsibilities:**
- Detect when an app needs a build (no `dist/`, stale `dist/`, lockfile changed, any source file mtime newer than `.build-stamp`)
- Run `pnpm install` if `node_modules/` is missing or `pnpm-lock.yaml` is newer than `node_modules/.pnpm-lock-stamp`
- Run the `build.command` from matrix.json
- Capture stdout/stderr, stream to a per-app build log at `~/apps/{slug}/.build.log` (capped at 10 MB, LRU-truncated)
- Enforce `build.timeout` (default 120s) via AbortSignal on the child process
- Write `.build-stamp` JSON with `{ lockfile_hash, source_hash, built_at, exit_code }` on success
- On failure: leave stamp absent, surface typed `BuildError` to gateway, emit `app:build_failed` event
- Serialize concurrent builds for the same slug via a per-slug mutex
- Run multiple builds in parallel across different slugs, capped at 4 concurrent worker processes to bound CPU

**Cache invalidation rules:**
- `pnpm-lock.yaml` changed since `.pnpm-lock-stamp` → full `pnpm install` + `pnpm build`
- Any file matching `build.sourceGlobs` has mtime > `.build-stamp.built_at` → `pnpm build` only
- `.build-stamp` absent → full rebuild

## Install Flow

**First install of an app from the gallery (spec 058):**
1. Installer downloads `{source.tar.gz, dist.tar.gz, manifest.json, publisher_signature}` + gallery-signed `listingTrust`
2. Validates publisher signature against store public key
3. Extracts source to `~/apps/{slug}/`
4. Validates `matrix.json` against the runtime version contract (semver match)
5. Computes `distributionStatus` from `listingTrust` + current runtime capabilities via the policy function in §Trust tiers. The computation is the **only** place environment flags and sandbox capabilities are consulted; downstream code just reads the resulting status.
6. Dispatch on the computed status: `installable` → proceed; `gated` → require an explicit user ack token on the install call (`409 install_gated` if absent — ack unlocks unambiguously); `blocked` → refuse with `403 install_blocked_by_policy` (no ack UI is shown for this case; see §Trust tiers for why `ALLOW_COMMUNITY_INSTALLS=0` resolves to `blocked`, not `gated`).
7. Extracts `dist.tar.gz` to `~/apps/{slug}/dist/`. For `first_party` and `verified_partner`, the install flow trusts the pre-built artifact and writes `.build-stamp` from the publisher's source hash. For `community`, the install flow always rebuilds from source (`pnpm install && pnpm build`), hashes `dist/`, and fails on mismatch with the publisher's declared hash — this catches supply-chain tampering even though it does not constrain runtime behavior.
8. Registers in the app catalog with `{ listingTrust, distributionStatus, installedAt, ackTokenId? }`
9. For `runtime: "node"`: does NOT auto-start; waits for first user open

**Trust tiers.** Spec 063 owns the install/run boundary, not the gallery. Spec 058 (App Gallery) owns publishing, listing, review, and audit. The two specs meet on two manifest fields:

```
listingTrust:       "first_party" | "verified_partner" | "community"
distributionStatus: "installable" | "gated" | "blocked"
```

- `listingTrust` is set by spec 058 at publish/audit time and is carried on the manifest delivered to this runtime.
- `distributionStatus` is the runtime's decision about whether to actually install and run this tier *today*, given what sandbox enforcement exists.

**Policy function (authoritative — matches `distribution-policy.ts`):**

```
computeDistributionStatus(listingTrust, caps):
  if listingTrust == "first_party":        return "installable"
  if listingTrust == "verified_partner":   return "installable"
  if listingTrust == "community":
    if caps.sandboxEnforced:               return "installable"  // spec 025 landed
    if caps.allowCommunityInstalls:        return "gated"        // ack will unlock
    return "blocked"                                             // production default
  return "blocked"                                               // fail-closed for unknown tiers

caps = {
  sandboxEnforced:       boolean  // spec 025 enforcement points wired up (false in this spec)
  allowCommunityInstalls: boolean  // env flag ALLOW_COMMUNITY_INSTALLS === "1"
}
```

**Runtime policy in this spec (pre-025):**

| `listingTrust` | `ALLOW_COMMUNITY_INSTALLS` | `distributionStatus` | Shell behavior |
|---|---|---|---|
| `first_party` | — | `installable` | Normal install, trusted path, auto-start on open |
| `verified_partner` | — | `installable` | Normal install, trusted path, warning badge in shell |
| `community` | `0` (production default) | `blocked` | Read-only card with "unavailable in this environment" copy. **No ack UI.** |
| `community` | `1` (operator opt-in) | `gated` | "I understand the risk" confirm → ack unlocks the session unambiguously |

**Invariant:** if the shell renders an ack UI for a `gated` app, submitting that ack MUST be able to succeed. The policy function is the only gate; the session endpoint and the install endpoint both consult it (they do not re-apply env flags independently). This prevents the "ack a confirm that can never succeed" bug class.

**Runtime policy in this spec (post-025, for reference only):** spec 025 lands the sandbox enforcement points (egress allowlist, bridge capability gating, filesystem chroot, `permissions` enforcement). When it does, `caps.sandboxEnforced = true` flips `community` straight to `installable` regardless of `ALLOW_COMMUNITY_INSTALLS`. The env flag becomes a dev-mode override and will eventually be removed.

**What spec 063 does NOT do:**

- Spec 063 does not gate the gallery. Community apps can be published, listed, reviewed, and rated in 058 regardless of what 063 does with installs.
- Spec 063 does not define `listingTrust`. It reads the field from the manifest and trusts spec 058's audit pipeline to set it correctly.
- Spec 063 does not define the "I understand the risk" UI. The runtime only exposes the `distributionStatus` to the shell and refuses the install call if the status is `gated` without an explicit ack token on the install request.

**What the community rebuild-and-hash step (§Install Flow step 7) catches:** tampering between publisher and install. Rebuilding from source and comparing hashes detects supply-chain injection but does NOT constrain what a malicious-by-design app can do at runtime. That is why `community` is `gated` on arrival, not `blocked` on publish.

**`permissions` field:** documented as **advisory metadata** in Phases 1-4 of this spec. The runtime reads it, the shell displays it at install time, but nothing enforces it until spec 025 lands the enforcement layer. This is the same forward-compat pattern used for `scope: "shared"` — schema-first, enforcement second.

**Reinstall (upgrade):**
- Stop any running process (graceful SIGTERM)
- Delete `~/apps/{slug}/` except `data/` and `config/`
- Run fresh install flow
- Restart the process if it was running before

**Removal:**
- Stop the process
- Delete `~/apps/{slug}/` entirely (preserving `~/data/{slug}/` unless explicitly requested)
- Emit `app:removed` event

## pnpm Store Configuration

- Global store at `~/.pnpm-store` (container default)
- `~/apps/{slug}/node_modules` uses hard links into the store; each app adds a few MB at most
- `.npmrc` in every app directory: `store-dir=~/.pnpm-store\nlink-workspace-packages=false`
- Build orchestrator runs `pnpm install --frozen-lockfile` (CI mode — no lockfile writes)

## Shell Changes (AppViewer)

**File**: `shell/src/components/AppViewer.tsx`

**Current behavior**: iframe src = `/files/{path}` where `path` is the raw file path in the home dir.

**New behavior:** iframe src is **always** `/apps/{slug}/`, regardless of runtime mode. The gateway dispatcher handles the static / vite / node decision server-side. The shell does not construct mode-specific URLs.

```
iframe.src = "/apps/" + slug + "/";   // single URL shape for all runtime modes
```

The bridge script injection (theme, data subscriptions, sendToKernel) works identically for all three modes because they all render in same-origin iframes under the shell origin.

**Runtime detection**: AppViewer calls `fetchAppManifest(slug)` on mount to retrieve `{ manifest, runtimeState, distributionStatus }` — the same envelope the gateway computes for `GET /api/apps/:slug/manifest` (see plan Task 6). `manifest.runtime` drives error-card affordances ("Retry build" vs "Retry start" vs "Rebuild"), `runtimeState.status` drives iframe-vs-error-card rendering, and `distributionStatus` drives the install gate (installable / gated / blocked). The iframe src shape does not depend on any of them.

**Session bootstrap**: before setting `iframe.src`, AppViewer calls `POST /api/apps/:slug/session` with `Authorization: Bearer <token>` (standard shell auth). This sets the path-scoped `matrix_app_session__{slug}` cookie — see §Authorization. Only after the session endpoint returns 200 does AppViewer assign the iframe src.

**Session refresh after expiry (the tricky case).** A fresh top-level iframe navigation that lands on a 401 cannot rely on the bridge — the app hasn't loaded yet, there is no script to read response headers, and `iframe.onload` still fires on a 401 HTML body so it is not a reliable probe. We need a wire-level mechanism. **Concretely:** when the dispatcher would return 401 to a navigation request, it returns a tiny same-origin HTML page (see §Authorization "401 interstitial") whose only job is to `postMessage({ type: "matrix-os:session-expired", slug }, window.location.origin)` to its parent and render a minimal loading state. AppViewer listens on `window.addEventListener("message", ...)`, matches on (`event.origin === window.location.origin`, `event.source === iframe.contentWindow`, `data.type === "matrix-os:session-expired"`, `data.slug === this.slug`), calls `openAppSession(slug)` to refresh the cookie, and reassigns `iframe.src` to the same URL to trigger reload. For XHR/fetch calls from inside an already-booted app, the dispatcher returns JSON `401` with the `Matrix-Session-Refresh` header (content negotiation on `Accept: text/html` picks which branch). This gives one concrete recovery path for navigations and one for in-app requests, with no reliance on onload probes or response-header sniffing from JS.

**Failure display**: if `runtimeState.status` is `build_failed` or `process_failed`, the iframe is replaced with an error card showing the log tail and a "Retry" action. If `runtimeState.status` is `needs_build`, the card shows "Build required" with a one-click build trigger.

**Distribution gate**: if the manifest envelope carries `distributionStatus: "gated"`, AppViewer does not call `POST /api/apps/:slug/session` at all — it renders the "I understand the risk" confirm first. After the user acks, it requests a session token carrying the ack; the server re-computes `distributionStatus` and, because the same policy function is used, issuing the cookie must succeed (invariant from §Trust tiers). If `distributionStatus: "blocked"`, the card is read-only with no ack affordance, and the session endpoint refuses with `403 install_blocked_by_policy` — the shell will never reach that refusal in normal flow because it does not render the ack UI for `blocked`, so the `403` is a race-defense check only.

## Security

Per CLAUDE.md Mandatory Code Patterns:

### Authorization (route matrix)

**Scope note:** this spec authorizes `scope: "personal"` apps only. `scope: "shared"` apps live under `~/groups/{group_slug}/apps/{app_slug}/` and are served by routes owned by spec 062 (`/ws/groups/{slug}/{app}` plus the group HTTP routes in spec 062 §H). Spec 063 accepts `scope: "shared"` in the manifest schema for forward-compat but does not mount them under `/apps/:slug/*`. The install flow rejects a shared-scope app at the personal install path with a typed `ManifestError.code = "scope_mismatch"`. Spec 062 owns the parallel routes for group-scoped apps.

**Principal model.** Matrix OS today runs **one gateway per user container** (per constitution §Isolation). The shared bearer token in `packages/gateway/src/auth.ts` is the only principal the gateway knows, and every `/apps/:slug/*` request inside this gateway is on behalf of the container owner. Spec 062 introduces multi-member visibility via a different route shape (`/groups/:group_slug/…`), so inside this spec we do not need cross-user authorization — we only need a way for an iframe navigation to prove it came from the authenticated shell.

**The wrinkle.** iframe navigation to `/apps/{slug}/*` is initiated by the browser, which cannot attach an `Authorization: Bearer` header to a navigation request. This is the same class of problem the existing WebSocket routes solve with `WS_QUERY_TOKEN_PATHS` (`auth.ts:17`). This spec solves it with a short-lived signed cookie issued by a shell-authenticated session endpoint.

| Route | Caller | Auth mechanism | Check |
|---|---|---|---|
| `GET /api/apps/:slug/manifest` | Shell `fetch` | `Authorization: Bearer <token>` (standard `authMiddleware`) | `authMiddleware` + `SAFE_SLUG` |
| `POST /api/apps/:slug/session` | Shell `fetch` | `Authorization: Bearer <token>` | `authMiddleware` + `SAFE_SLUG` + manifest exists + `scope === "personal"` + `distributionStatus !== "blocked"` + (ack token required when `distributionStatus === "gated"`) |
| `GET/POST /apps/:slug/*` (HTTP) | Browser iframe navigation and subresources (static + vite + node) | Path-scoped signed cookie `matrix_app_session__{slug}` | `appSessionMiddleware` → `appRuntimeDispatcher` |
| `GET /apps/:slug/ws` (WebSocket upgrade) | Browser iframe | Same cookie (cookies attach to the WS handshake) | `appSessionMiddleware` (rejects in static/vite modes, forwards in node mode) |
| `GET /groups/:group_slug/apps/:app_slug/*` | — | — | **Reserved for spec 062**; spec 063 does not mount this route |
| `GET /files/*` (non-app files) | Shell `fetch` with bearer | `Authorization: Bearer <token>` | `authMiddleware` (existing behavior, unchanged). No `/files/apps/...` iframe navigation — the dispatcher is the only path. |

**Single URL prefix — no `/files/apps/…` iframe path.** AppViewer always navigates to `/apps/{slug}/`; the dispatcher reads the manifest and serves files (static/vite) or proxies upstream (node). This means we need **exactly one** cookie, with path `Path=/apps/{slug}/`, which covers every request the iframe makes.

**Cookie shape (`matrix_app_session__{slug}`):**

```
version | slug | principal | scope | expiresAt | HMAC
   v1   | str  | str       | enum  | unix_ms   | HMAC-SHA256
```

- Signed with `HMAC(derivedKey, canonicalize(payload))`, base64url-encoded as the cookie value. `derivedKey = HKDF-SHA256(gatewayToken, "matrix-os/app-session/v1")` so the cookie-signing key is not the raw bearer token
- `Path=/apps/{slug}/` — **not** `Path=/`. The cookie is only attached to requests under this app's prefix. A compromised cookie for `notes` is not sent to `/apps/calendar/*`, `/api/*`, or anywhere else
- `HttpOnly` (JS cannot read), `SameSite=Strict` (no cross-site attachment), `Secure` when the gateway is behind TLS
- `Max-Age=600` (10 min) — matches typical active use without forcing a refresh on every interaction
- Cookie name embeds the slug (`matrix_app_session__{slug}`) so opening two apps in parallel never clobbers state even inside the single-origin cookie jar
- `principal` is a constant (`"gateway-owner"`) in this spec. Spec 062 extends the payload by adding `group_id` and promoting `principal` to a Matrix handle — the `version` field lets `appSessionMiddleware` accept both v1 and v2 cookies during the transition
- `scope` is always `"personal"` in this spec. v2 adds `"shared"` and the middleware routes it to the group-aware verifier

**Why path-scoping matters (and why we explicitly rejected `Path=/`):** a `Path=/` cookie is attached by the browser to every request to the gateway origin, including `/api/*`, `/ws/*`, and other apps' `/apps/other-slug/*` routes. That widens the exfil blast radius without any benefit — `appSessionMiddleware` is only ever consulted from `/apps/:slug/*`. Path scoping is the browser's built-in containment; using it is free security.

**Forward-compat contract for spec 062:** the cookie payload is a versioned tuple, not an ad-hoc string. Adding `group_id` / multi-user principals is a schema bump inside `appSessionMiddleware`, not a protocol change on the routes. The route table above explicitly reserves `/groups/:group_slug/apps/:app_slug/*` so spec 062 can mount its own middleware (with its own `Path=/groups/{group}/apps/{app}/` cookie) without colliding with this one.

**Flow:**

1. Shell calls `GET /api/apps/:slug/manifest` with bearer → receives `{ manifest, runtimeState, distributionStatus }`
2. If `distributionStatus === "installable"`, shell calls `POST /api/apps/:slug/session` with bearer. If `"gated"`, shell first renders the ack UI and only proceeds with the session call after the user acks (request carries the ack token). If `"blocked"`, shell renders the read-only card and never calls the session endpoint.
3. Gateway validates bearer, re-computes `distributionStatus` server-side (never trusted from the client), asserts `manifest.scope === "personal"`, signs a fresh v1 payload, sets the cookie via `Set-Cookie: matrix_app_session__{slug}=…; Path=/apps/{slug}/; HttpOnly; SameSite=Strict; Secure; Max-Age=600`, returns `200 { expiresAt }`
4. Shell assigns `iframe.src = "/apps/:slug/"`
5. Browser navigates; the cookie attaches automatically because the request path is under `/apps/{slug}/`; `appSessionMiddleware` verifies version + HMAC + slug match + expiry + scope; dispatcher serves the response
6. Subresources and API calls inside the iframe (same-origin, same prefix) carry the cookie automatically
7. On cookie expiry, `appSessionMiddleware` returns `401` via one of two branches (see §401 interstitial): navigation requests get the static HTML interstitial that posts `session-expired` to `window.parent`; in-app XHR/fetch gets a JSON `401` with `Matrix-Session-Refresh`. In both cases AppViewer ends up re-calling `POST /api/apps/:slug/session` and reassigning `iframe.src`

**401 interstitial (navigation recovery mechanism).** When `appSessionMiddleware` rejects a request, it picks one of two response shapes via content negotiation on the `Accept` header:

- **Request was a top-level iframe navigation** (`Accept` contains `text/html`): return `401` with a fixed, static, same-origin HTML body that is byte-for-byte identical every time (no slug interpolation beyond `document.title`, no timestamps, no user data). The body is just:

    ```html
    <!doctype html>
    <meta charset="utf-8">
    <title>Refreshing session…</title>
    <style>html,body{margin:0;background:#0b0b0b;color:#ccc;font:14px system-ui;display:grid;place-items:center;height:100%}</style>
    <body>Refreshing session…</body>
    <script>
    (function () {
      var m = location.pathname.match(/^\/apps\/([a-z0-9][a-z0-9-]{0,63})\//);
      if (!m) return;
      if (window.parent === window) return;  // not in an iframe: nothing to notify
      try {
        window.parent.postMessage(
          { type: "matrix-os:session-expired", slug: m[1] },
          window.location.origin
        );
      } catch (e) { /* ignore */ }
    })();
    </script>
    ```

  Headers on this response: `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Frame-Options: SAMEORIGIN`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'`. The CSP is intentionally narrow — this page has no app-supplied state and runs nothing beyond the parent-notification one-liner. The `Matrix-Session-Refresh` header is still set so server-side observability and tests can match on it, but JS never reads it.

- **Request was an in-app XHR/fetch** (`Accept` contains `application/json` or `Sec-Fetch-Mode: cors`/`same-origin` without `text/html`): return `401` with JSON `{ error: "session_expired", correlationId }` and header `Matrix-Session-Refresh: /api/apps/:slug/session`. App code is expected to intercept its own fetches, or rely on a `fetch` wrapper from `@matrix-os/client` that auto-re-tries after a refresh message.

**postMessage contract (shell-side):**

- Listener: `window.addEventListener("message", handler)` inside `AppViewer`
- Accept the message only if **all** of the following hold:
  - `event.origin === window.location.origin` (same-origin enforced by string match, not substring)
  - `event.source === iframeRef.current?.contentWindow` (identity match on the exact iframe this viewer owns; prevents cross-viewer message spoofing)
  - `event.data?.type === "matrix-os:session-expired"`
  - `event.data?.slug === this.props.slug` (defense in depth: the URL the interstitial saw should match the app this viewer thinks it's showing)
- Debounce: if a second `session-expired` message arrives within 2 seconds, drop it — the first refresh is already in flight
- Action: `await openAppSession(slug)` (which `POST`s to `/api/apps/:slug/session` with the bearer), then `iframeRef.current.src = "/apps/" + slug + "/"` to trigger the reload

**Why this specific shape:**

- A static, byte-identical body means the interstitial cannot leak information and cannot be used to smuggle anything into the iframe context
- `postMessage` to `window.parent` with explicit `targetOrigin` (the shell's origin) means the message is only delivered to a same-origin embedder; cross-origin embedders that try to iframe us get silence
- The shell-side identity check on `event.source` prevents another iframe on the same page (e.g. two AppViewers side by side) from reacting to each other's expiry
- JSON vs HTML content negotiation gives one branch per caller type without trying to sniff `User-Agent` or `Sec-Fetch-Dest` (which vary across browsers)
- `iframe.onload` is never consulted for this — the only signal is the postMessage from the interstitial

**Tests (additions to `app-session-middleware.test.ts` and a new `app-viewer-session-refresh.test.ts`):**

- GET `/apps/notes/` with no cookie + `Accept: text/html` → 401 with HTML body containing the exact postMessage script; response body byte-compared against a fixture
- GET `/apps/notes/api/data` with no cookie + `Accept: application/json` → 401 JSON with `Matrix-Session-Refresh` header
- GET `/apps/notes/` with expired cookie + `Accept: text/html` → 401 HTML (same branch as no cookie)
- The interstitial body is byte-identical across slugs (test against two different slugs, assert equal bytes) — no user/app-controlled substitution
- The interstitial response has `X-Frame-Options: SAMEORIGIN` and the documented CSP
- Shell: AppViewer that mounts a mocked iframe, receives a `matrix-os:session-expired` postMessage from the correct `event.source`, asserts `openAppSession` was called once and iframe src was reassigned
- Shell: AppViewer ignores postMessage from `event.source !== iframeRef.current.contentWindow` (spoofing defense)
- Shell: AppViewer ignores postMessage from `event.origin !== window.location.origin`
- Shell: AppViewer ignores `session-expired` messages that name a different slug
- Shell: two `session-expired` messages within 2s debounce — `openAppSession` called exactly once

**What this prevents:**
- Leaked iframe URL cannot be opened from another browser — no cookie, no access
- CSRF against `/apps/:slug/*` is blocked by `SameSite=Strict`
- Cross-slug confusion is blocked by binding the cookie to a single slug (name AND signed payload AND path)
- Cross-path exfiltration is blocked by `Path=/apps/{slug}/` — a stolen cookie cannot even be attached to `/api/*` or other apps' prefixes by the browser
- Accidentally serving a shared-scope app through the personal route is blocked by the `scope` field on the cookie (defense in depth against a future wiring bug)
- A malicious publisher setting `distributionStatus: "installable"` in their own manifest cannot bypass the gate, because the manifest schema rejects that field outright and the server always computes the value
- An expired-cookie navigation cannot wedge the iframe in a 401 state forever, because the interstitial notifies the shell unconditionally and the shell's refresh path is the only recovery

**Tests (new file `tests/gateway/app-runtime/app-session-middleware.test.ts` + additions to the dispatcher test file):**
- `/apps/notes/` without cookie → 401 + `Matrix-Session-Refresh` header present
- `/apps/notes/` with a cookie signed for `another-slug` → 401
- `/apps/notes/` with a cookie whose HMAC verifies but version is unknown → 401 (no silent downgrade)
- `/apps/notes/` with expired cookie → 401 + refresh header
- `/apps/notes/` with valid cookie → 200, dispatches to the correct branch for each runtime mode
- `POST /api/apps/:slug/session` sets `Path=/apps/{slug}/` (assert the exact `Set-Cookie` header)
- `POST /api/apps/:slug/session` sets `HttpOnly`, `SameSite=Strict`, `Secure` (under TLS)
- Browser simulation: a cookie for `notes` is NOT sent to `/apps/calendar/` (path-scoping correctness — exercises the cookie jar, not just our middleware)
- WebSocket upgrade without cookie → 401 before dispatching
- `POST /api/apps/:slug/session` for a `scope: "shared"` app → 409 `scope_mismatch` (spec 062 handles group-scope session issuance)
- `POST /api/apps/:slug/session` for a `distributionStatus: "gated"` app without an ack token → 409 `install_gated`
- `POST /api/apps/:slug/session` for a `distributionStatus: "blocked"` app → 403 `install_blocked_by_policy`
- A manifest file on disk containing `distributionStatus: "installable"` → Zod schema rejects it with a typed `ManifestError.code = "computed_field_not_authored"`

### External calls (proxy → child process)
- Every proxied fetch has `AbortSignal.timeout(30000)` for HTTP, 60s idle for WebSocket
- Backend errors never leak to client (generic 502 with correlation ID; full error in server log only)

**Input validation:**
- Hono `bodyLimit(10 * 1024 * 1024)` on proxied routes
- Slug validated with `SAFE_SLUG` regex (`^[a-z0-9][a-z0-9-]{0,63}$`) before any filesystem path construction
- Manifest path passed through `resolveWithinHome()` before read
- Port allocation validates range; rejects ports outside 40000-49999

**Resource management:**
- Process slot map capped at 10, LRU eviction
- Port pool capped at 100 slots, released on process stop or crash
- Build log files capped at 10 MB, oldest lines truncated first
- `ProcessRecord` entries cleaned up on `removed` state
- Graceful shutdown on gateway stop drains all processes

**Child process isolation (first pass):**
- Run as the same user as the gateway (container is the security boundary)
- Env vars whitelisted via `safeEnv()` — no inherited secrets
- Memory limit via Node `--max-old-space-size={memoryMb}` flag injected into `start` command
- File descriptor limit via `prlimit --nofile={maxFileHandles}` wrapper on Linux; best-effort on macOS dev
- No egress network restrictions in this spec — covered by future spec 025 (outbound proxy)
- `NODE_OPTIONS` stripped from inherited env to prevent debugger injection

**Error handling:**
- No bare `catch { return null }` anywhere in process manager or proxy
- Typed error classes: `BuildError`, `SpawnError`, `HealthCheckError`, `ProxyError`, `ManifestError`
- Every `catch` distinguishes connection failures, timeouts, and application errors
- Build failures surface with `{ stage: "install" | "build", exitCode, stderrTail }`

## Failure Modes

| Failure | Detection | Response |
|---|---|---|
| `pnpm install` fails | Non-zero exit | `build_failed` event, UI shows "Install failed: {stderr tail}", app not runnable |
| `pnpm build` fails | Non-zero exit | Same, `dist/` left in previous state if it existed |
| Build exceeds timeout | AbortSignal fires | Kill process group, mark `build_failed` with `reason: "timeout"` |
| Child process fails health check | Poll timeout | Mark `startup_failed`, shut down process, release port |
| Child process crashes after healthy | `exit` with nonzero code | Restart with backoff (1s / 4s / 16s), max 3 retries, then `failed` |
| Child process OOM | `exit` with signal `SIGKILL` or code 137 | Same as crash, log memory limit hit, surface to UI |
| Port collision | `EADDRINUSE` on bind | Release port, re-allocate from pool, retry once |
| Gateway restart (process manager lost) | N/A | On startup scan `~/apps/*/matrix.json`, do NOT auto-start, empty ProcessRecord map |
| Disk full during install | `ENOSPC` | Abort, clean up partial `node_modules`, surface typed error to UI |
| Malformed `matrix.json` | Zod parse fails | Reject app load, log, surface to UI |
| App imports missing dep | Runtime error in child | Reported via child stderr → build log → UI |
| Request while process is `starting` | State check in proxy | Await `startupPromise` (with timeout), then forward |
| Request while process is `failed` | State check in proxy | Return 503 "App failed to start", include correlation ID |
| Concurrent `ensureRunning` calls | State check before spawn | Return the existing `startupPromise` so only one spawn happens |
| `pnpm-lock.yaml` tampered post-install | Hash mismatch on next build | Fail build with `BuildError.code = "lockfile_tampered"` |

## Testing

**Unit tests** (`tests/gateway/app-runtime/`):
- `manifest-schema.test.ts` — valid/invalid parses, runtime enum, semver ranges, default values
- `process-manager.test.ts` — spawn, health check, idle shutdown, LRU eviction, crash retry backoff, port allocation, slot exhaustion, concurrent `ensureRunning` dedup
- `port-pool.test.ts` — allocation/release, exhaustion, cleanup on crash
- `dispatcher.test.ts` — static/vite/node branches, mode dispatch on manifest, HTTP forwarding, WebSocket upgrade (node only), error pass-through, timeout behavior, header sanitization (strip every client-controlled forwarded header), bodyLimit enforcement
- `app-session.test.ts` — HMAC sign/verify round-trip, version rejection, expiry, HKDF key derivation
- `app-session-middleware.test.ts` — cookie path scoping (`Path=/apps/{slug}/` not `Path=/`), cross-slug rejection, path-scoping enforced by browser cookie jar
- `distribution-policy.test.ts` — trust tier policy table, fail-closed default
- `build-orchestrator.test.ts` — cache hit, cache miss, lockfile invalidation, concurrent build serialization, timeout handling
- `install-flow.test.ts` — first-party/verified-partner trusted path, community rebuild-and-hash, rollback on failure, signature verification, distributionStatus gate

**Integration tests** (`tests/gateway/app-runtime-integration.test.ts`):
- Install a real Vite template app from `tests/fixtures/apps/hello-vite`, run build, serve dist, validate response
- Install a real Next.js fixture from `tests/fixtures/apps/hello-next`, spawn process, proxy a request, receive SSR HTML, validate graceful shutdown
- Concurrent requests to a starting process (should serialize on `startupPromise`)
- Crash-restart loop with a fixture that crashes on first request; verify `failed` after max retries
- Idle shutdown after clock advance (`vi.useFakeTimers`)

**E2E test** (`tests/e2e/app-runtime.spec.ts`, Playwright):
- Sign in, open a Vite default app, interact, close, reopen, verify state persistence
- Open a Node default app, verify it cold-starts, interact, idle 5 min (fake clock), verify it shuts down, reopen verifies cold-start again
- Screenshot the "build failed" error card

## File Structure

```
packages/gateway/src/app-runtime/
  manifest-schema.ts          # Zod schema for matrix.json runtime fields (rejects authored distributionStatus)
  manifest-loader.ts          # reads + validates matrix.json, caches by mtime
  process-manager.ts          # ProcessRecord lifecycle + port pool
  port-pool.ts                # 40000-49999 allocation/release
  dispatcher.ts               # single Hono handler for /apps/{slug}/* across static/vite/node
  serve-static.ts             # thin wrapper over existing /files/* helpers, scoped per app dir
  app-session.ts              # HMAC signer/verifier, HKDF key derivation, buildSetCookie(Path=/apps/{slug}/)
  app-session-middleware.ts   # Hono middleware verifying matrix_app_session__{slug}
  distribution-policy.ts      # computeDistributionStatus(listingTrust, sandboxCapabilities())
  runtime-state.ts            # maps build-stamp + process-record to manifest API envelope
  build-orchestrator.ts       # pnpm install + build + cache
  build-cache.ts              # .build-stamp read/write, hash computation
  install-flow.ts             # Trust-tier install paths, distributionStatus gate
  safe-env.ts                 # Env whitelist builder
  errors.ts                   # Typed error classes
  index.ts                    # Public API

shell/src/components/
  AppViewer.tsx               # Unified /apps/{slug}/ src, session bootstrap, ack UI, error cards

shell/src/lib/
  app-manifest-cache.ts       # Client-side manifest cache (60s TTL, 2s for non-ready)
  app-session.ts              # openAppSession(slug, {ack?}) client wrapper

tests/gateway/app-runtime/
  manifest-schema.test.ts
  process-manager.test.ts
  port-pool.test.ts
  dispatcher.test.ts
  app-session.test.ts
  app-session-middleware.test.ts
  distribution-policy.test.ts
  build-orchestrator.test.ts
  install-flow.test.ts
tests/gateway/app-runtime-integration.test.ts
tests/e2e/app-runtime.spec.ts

tests/fixtures/apps/
  hello-vite/                 # minimal Vite React app for tests
  hello-next/                 # minimal Next.js app for tests
  crash-on-request/           # fixture that crashes on first HTTP request

home/apps/_template-vite/     # Vite React scaffold for AI authoring
  package.json
  vite.config.ts
  tsconfig.json
  src/App.tsx
  src/main.tsx
  src/matrix-os.d.ts          # types for the bridge
  index.html
  matrix.json
home/apps/_template-next/     # Next.js scaffold for AI authoring
  package.json
  next.config.ts              # basePath pre-wired from MATRIX_APP_SLUG
  tsconfig.json
  app/page.tsx
  app/layout.tsx
  app/api/health/route.ts
  matrix.json

home/agents/skills/
  build-vite-app.md           # AI skill: scaffold + edit + build Vite app
  build-next-app.md           # AI skill: scaffold + edit + build Next.js app
  pick-app-runtime.md         # AI decision tree: static vs vite vs node
```

## AI Authoring Flow

When the AI is asked to build a new app:

```bash
# Vite SPA (most common)
cd ~/apps
cp -r _template-vite my-grocery-list
cd my-grocery-list
# edit src/App.tsx, matrix.json
pnpm install
pnpm build
# platform file watcher picks up the new dir and registers it
```

For Next.js:
```bash
cd ~/apps
cp -r _template-next my-dashboard
cd my-dashboard
# edit app/page.tsx, app/api/*, matrix.json
pnpm install
pnpm build
# platform will spawn the process on first open
```

Templates are pre-lockfile-resolved so the first build is fast (pnpm store already contains every pinned version). Skills teach the AI:
- Scaffold commands
- How to read/update matrix.json
- Where to put assets
- How to use `matrix-os/client` (typed wrapper over the postMessage bridge) for kernel communication, theme, and data subscriptions
- How to wire up per-app Postgres (spec 050)

## App Store Implications

**Publish flow:**
1. Publisher runs `matrix app publish` from the app directory
2. CLI validates matrix.json against the runtime version contract
3. CLI runs `pnpm install --frozen-lockfile && pnpm build` and hashes `dist/`
4. Uploads `{source.tar.gz, dist.tar.gz, manifest.json, dist_hash, publisher_signature}` to the store
5. Store signs the bundle with its own key and stores the artifact

**Install path by `listingTrust`:** see §Install Flow (above) for the authoritative sequence — this section is a summary. In short:
- `first_party` / `verified_partner` → validate store signature, extract source + pre-built `dist/`, write `.build-stamp` with the declared hash. Ready in under 5 seconds.
- `community` → extract source only, run `pnpm install && pnpm build`, hash `dist/`, fail on mismatch with the publisher's declared hash. Gated by `distributionStatus` policy; not reachable in the default runtime config until spec 025 lands sandbox enforcement.

**Runtime version contract:**
- Each shell ships a `runtime` version (semver, e.g. `1.0.0`)
- An app's `runtimeVersion: "^1.0.0"` is checked at install time
- Shell refuses to install apps needing a newer runtime than it has
- Backward-compatible additions bump minor; breaking changes bump major

## Quality Gates Checklist

- [x] **Security architecture**: route/authz matrix above, per-slug signed cookie for iframe navigation, bearer token on shell-side endpoints, Zod manifest validation, slug regex, bodyLimit, env whitelist, typed errors, generic 502 responses, secrets never inherited by children. *Pending your call on cookie shape (see §Authorization "Open for your call").*
- [x] **Integration wiring**: process manager is a gateway singleton, reverse proxy is Hono middleware, build orchestrator is invoked by install-flow and a file watcher, manifest cache is shell-side with explicit TTL, session middleware mounted before reverse proxy
- [x] **Failure modes**: table below covers build fail, process crash, OOM, port collision, gateway restart, disk full, malformed manifest, concurrent spawn, cookie expiry
- [x] **Resource management**: process slot cap (10), port pool cap (100), build log cap (10 MB), memory/CPU/FD limits per process, graceful shutdown on gateway stop, LRU eviction when slot-exhausted
- [ ] **Runtime permission enforcement**: deferred to spec 025. `permissions` is advisory; `community` tier is `gated` on install pre-025 and flips to `installable` automatically post-025 via a single policy function. Does not block spec 058 from shipping community publishing/listing/review.

## Open Questions

1. **Should build output live in `~/apps/{slug}/dist/` or a separate `~/apps-built/{slug}/`?** Leaning separate to enable atomic swap on rebuild and keep source dirs clean for git.
2. **Do `static` apps support `dependencies` for consistency?** Probably yes — expose the shared runtime import map via a `/runtime.json` endpoint so static apps can opt into ESM imports.
3. **Next.js basePath** — generate a wrapper `next.config.js` that injects `basePath` from `MATRIX_APP_SLUG`, or require publishers to configure it manually? Leaning generated wrapper for safety.
4. **Dev mode HMR** — out of scope here, but the eventual flag lives on `matrix.json` as `dev: true` and runs `pnpm dev` instead of serving `dist/`. Separate follow-up spec.
5. **Per-app secrets** — how do Mail/Inbox access Pipedream tokens? Via gateway-provided `MATRIX_GATEWAY_URL` and a per-app auth token injected at spawn time. Detail owned by spec 049 integration plumbing.

## Implementation Phases

**Phase 1 — Static + Vite (no process)**: manifest schema, build orchestrator, install flow (trusted path), AppViewer mode switch. No process manager needed. Unblocks spec 060 for Vite apps immediately.

**Phase 2 — Node runtime**: process manager, port pool, reverse proxy, `ensureRunning` semantics, crash recovery, idle shutdown. Required for any Next.js app.

**Phase 3 — Gallery-to-runtime install path**: publish CLI, reproducible build hashing, runtime version negotiation. Runtime reads `listingTrust` from the install bundle (delivered by spec 058) and computes `distributionStatus`:
- `first_party` → `installable`
- `verified_partner` → `installable`
- `community` + `ALLOW_COMMUNITY_INSTALLS=1` → `gated` (ack unlocks)
- `community` + `ALLOW_COMMUNITY_INSTALLS=0` (production default) → `blocked` (no ack UI; refused unambiguously)

Phase 3 does **not** block spec 058 from shipping community publishing, listing, audit, or reviews — those live entirely in the gallery. The gate is only on install/run in this runtime, and lifts automatically once spec 025 lands.

**Phase 4 — Dev mode**: `pnpm dev` with HMR WebSocket proxy. Developer-only behind a flag.

**Sandbox unlock (spec 025, not a phase of this spec)**: when spec 025 delivers egress allowlist, bridge capability gating, filesystem chroot, and `permissions` enforcement, the runtime flips `community` from `gated` to `installable` by changing the one policy function in `install-flow.ts`. No schema change. No route change. Existing community listings in spec 058 become normally installable without republishing.

Spec 060 depends on Phase 1. Phases 2-4 can land independently without blocking app development. The sandbox unlock is tracked under spec 025 and lifts a runtime gate; it is not gated work that this spec owns.
