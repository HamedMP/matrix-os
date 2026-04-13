---

description: "Task list for spec 063: React App Runtime"
---

# Tasks: React App Runtime (Spec 063)

**Input**: Design documents from `/specs/063-react-app-runtime/`
**Prerequisites**: plan.md, spec.md

**Tests**: Included. Per CLAUDE.md constitution, TDD is non-negotiable — tests are written first (Red) before implementation (Green) on every task.

**Organization**: Tasks are grouped by user story (runtime tier) so each story can be implemented, tested, and shipped as an independent increment that unblocks downstream work in spec 060.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 = Vite SPA runtime (P1/MVP), US2 = Node runtime (P2), US3 = Gallery install path (P3), US4 = Dev mode stub (P4)

## Story Map (spec phase → user story)

| Story | Spec Phase | Goal | Unblocks |
|---|---|---|---|
| **US1 (P1/MVP)** | Phase 1: Static + Vite | Install, build, and serve a Vite React app through `/apps/:slug/` with signed-cookie auth | Spec 060 Wave 2 |
| **US2 (P2)** | Phase 2: Node runtime | Spawn Next.js child processes, reverse-proxy HTTP + WebSocket through the same dispatcher | Spec 060 Wave 3 |
| **US3 (P3)** | Phase 3: App store | `matrix app publish` + verified install (rebuild + hash compare) + runtime version negotiation + install-time trust gate | Spec 058 install side |
| **US4 (P4)** | Phase 4: Dev mode | Schema-only placeholder for `dev: true` flag; HMR runtime deferred to a follow-up spec | — |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add new gateway dependencies and refresh the lockfile per CLAUDE.md.

- [ ] T001 Add `ws`, `semver`, and `glob` to `packages/gateway/package.json` dependencies
- [ ] T002 Run `pnpm install` from repo root and commit the updated `pnpm-lock.yaml` per CLAUDE.md lockfile rule

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types, schemas, and pure modules that every runtime story depends on. No user-visible behavior yet.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T003 [P] Create typed error classes (`BuildError`, `SpawnError`, `HealthCheckError`, `ProxyError`, `ManifestError`) in `packages/gateway/src/app-runtime/errors.ts`
- [ ] T004 [P] Write failing Zod manifest schema tests in `tests/gateway/app-runtime/manifest-schema.test.ts` (valid static/vite/node parses, reject authored `distributionStatus`, runtime enum, semver `runtimeVersion`, scope defaults, required `build` for vite/node, required `serve` for node)
- [ ] T005 Implement Zod manifest schema in `packages/gateway/src/app-runtime/manifest-schema.ts` — `z.strictObject(...).refine(m => !("distributionStatus" in m))`, exports `AppManifestSchema`, `parseManifest`, `type AppManifest`
- [ ] T006 [P] Write failing manifest loader tests in `tests/gateway/app-runtime/manifest-loader.test.ts` (load + validate, ManifestError on missing/invalid JSON, reject slug mismatch between dirname and `manifest.slug`, mtime cache + invalidation)
- [ ] T007 Implement manifest loader with mtime cache in `packages/gateway/src/app-runtime/manifest-loader.ts` — uses `resolveWithinHome`, returns `Result<AppManifest, ManifestError>` (no throws), `Map<slug, { mtime, manifest }>` with `invalidateManifestCache()`
- [ ] T008 [P] Write failing distribution-policy tests in `tests/gateway/app-runtime/distribution-policy.test.ts` covering the full truth table from spec §Trust tiers (first_party→installable, verified_partner→installable, community+no-flags→blocked, community+ALLOW_COMMUNITY_INSTALLS=1→gated, community+sandboxEnforced→installable, unknown→blocked) plus the "every gated must be ack-unlockable" invariant
- [ ] T009 Implement pure `computeDistributionStatus(listingTrust, caps)` plus `sandboxCapabilities()` helper in `packages/gateway/src/app-runtime/distribution-policy.ts` — no side effects, no env reads inside the policy function itself
- [ ] T010 [P] Write failing app-session signer/verifier tests in `tests/gateway/app-runtime/app-session.test.ts` (round-trip v1 payload, reject tampered signature, reject expired, reject unknown version, constant-time verify via `timingSafeEqual`)
- [ ] T011 Implement HMAC signer + verifier + HKDF key derivation in `packages/gateway/src/app-runtime/app-session.ts` — `deriveAppSessionKey`, `signAppSession`, `verifyAppSession`, `buildSetCookie(slug, value, opts)` with `Path=/apps/{slug}/` hard-coded, Zod `AppSessionPayload` v1 schema

**Checkpoint**: Foundation ready — all three runtime user stories can now proceed.

---

## Phase 3: User Story 1 — Vite SPA Runtime (Priority: P1) 🎯 MVP

**Goal**: Install, build, and serve a Vite React app inside AppViewer via the unified `/apps/:slug/` path, gated by a signed per-app cookie. Existing `runtime: "static"` apps continue to work through the same dispatcher.

**Independent Test**: Copy the `hello-vite` fixture into a test gateway home, call the install flow, verify `dist/` is produced, `POST /api/apps/hello-vite/session` to get a cookie, `GET /apps/hello-vite/` returns 200 with HTML containing a `<script src="…js">` tag. A static app (`calculator-static`) served through the same dispatcher returns its `index.html`. A cookie issued for `calculator-static` is rejected on `/apps/hello-vite/` (path scoping).

### Tests for User Story 1 (written first, must FAIL before implementation)

- [ ] T012 [P] [US1] Write failing build-cache tests in `tests/gateway/app-runtime/build-cache.test.ts` (deterministic `hashSources`, change detection, `isBuildStale` true when stamp missing / lockfile changed / source mtime advances)
- [ ] T013 [P] [US1] Create `tests/fixtures/apps/hello-vite/` — minimal Vite React TS template with pinned `pnpm-lock.yaml`, no pre-built `dist/`
- [ ] T014 [P] [US1] Write failing build-orchestrator tests in `tests/gateway/app-runtime/build-orchestrator.test.ts` (fresh build, cache hit <500ms, rebuild on source change, `BuildError` on corrupt package.json, `timeout` code via AbortSignal, per-slug mutex serialization, `.build.log` written)
- [ ] T015 [P] [US1] Write failing install-flow trusted-path tests in `tests/gateway/app-runtime/install-flow.test.ts` (extract source, validate manifest, trigger build, register catalog entry, reject slug mismatch, reject incompatible `runtimeVersion`, cleanup partial install on failure, idempotent reinstall)
- [ ] T016 [P] [US1] Write failing manifest API tests in `tests/gateway/app-manifest-api.test.ts` (envelope `{manifest, runtimeState, distributionStatus}`, `needs_build` when stamp missing, `build_failed` stage/exitCode/stderrTail ≤2KB, `distributionStatus` recomputed server-side for community tier across env combinations, 404 missing, 400 bad slug, generic 500 on filesystem error)
- [ ] T017 [P] [US1] Write failing app-session middleware tests in `tests/gateway/app-runtime/app-session-middleware.test.ts` (401 HTML interstitial on `Accept: text/html`, 401 JSON with `Matrix-Session-Refresh` on `Accept: application/json`, interstitial body byte-identical across slugs, `X-Frame-Options: SAMEORIGIN`, CSP `frame-ancestors 'self'`, cross-slug cookie rejected, unknown version rejected, expired rejected, valid cookie sets `c.get('appSession')`, `POST /api/apps/:slug/session` cookie header contains `Path=/apps/{slug}/` and `HttpOnly` and `SameSite=Strict`, 409 `scope_mismatch` for shared-scope, 409 `install_gated` for community without ack, 403 `install_blocked_by_policy` for blocked tier)
- [ ] T018 [P] [US1] Write failing ack-route tests in `tests/gateway/app-runtime/ack-route.test.ts` — `POST /api/apps/:slug/ack` issues an opaque token tied to `slug` and `principal`, 5-minute TTL, one-time consumption (second use returns 401), bounded LRU (cap 32, oldest evicted), bearer-authed, 409 `scope_mismatch` on shared-scope, 403 `install_blocked_by_policy` when `distributionStatus === "blocked"`, 200 when `distributionStatus === "gated"`, 400 when the app is `installable` (ack not applicable)
- [ ] T019 [P] [US1] Write failing dispatcher tests (static + vite branches) in `tests/gateway/app-runtime/dispatcher.test.ts` — static serving, vite `dist/` serving, 503 `needs_build` when vite dist missing, path traversal rejected with 400, invalid slug 400, missing manifest 404, WebSocket upgrade rejected with 400 `ws_not_supported` in static/vite modes, does NOT touch process manager for static/vite
- [ ] T020 [P] [US1] Write failing shell manifest cache tests in `tests/shell/app-manifest-cache.test.ts` (60s TTL, 2s TTL for non-ready envelopes, LRU cap 32, `invalidateManifest` forces refetch)
- [ ] T021 [P] [US1] Write failing AppViewer runtime-modes tests in `tests/shell/app-viewer-runtime-modes.test.ts` — iframe src is `/apps/{slug}/` (never `/files/apps/…`) across static/vite, `openAppSession` called before src assignment, ack UI rendered when `distributionStatus === "gated"` → ack flow calls `POST /api/apps/:slug/ack` → then `openAppSession(slug, { ack })`, read-only card with no session call when `blocked`, build-failed card on `runtimeState.status === "build_failed"`, `postMessage` session refresh path (origin + source identity + slug match + 2s debounce + no `iframe.onload` probe)
- [ ] T022 [US1] Write failing auth-exemption tests in `tests/gateway/auth.test.ts` — `authMiddleware` returns `next()` without setting a principal for paths starting with `/apps/` (the prefix in `APP_IFRAME_PREFIXES`), still enforces the bearer on `/api/apps/:slug/manifest`, `/api/apps/:slug/session`, `/api/apps/:slug/ack`, and every non-`/apps/*` route (regression — no accidental bypass of `/api/*`)
- [ ] T023 [US1] Write failing Phase 1 integration test skeleton in `tests/gateway/app-runtime-phase1.test.ts` (static app served with cookie, 401 without cookie with `Matrix-Session-Refresh` header, Vite app install+build+serve, path-scoped cookie rejected cross-slug, manifest API returns correct runtime + distributionStatus, no double verification on `/apps/*` — exactly one 401 for an expired cookie)

### Implementation for User Story 1

- [ ] T024 [P] [US1] Implement build cache in `packages/gateway/src/app-runtime/build-cache.ts` — `hashSources` via `node:crypto` sha256 over sorted glob matches, `hashLockfile`, `readBuildStamp`/`writeBuildStamp` writing JSON `.build-stamp` with `{ sourceHash, lockfileHash, builtAt, exitCode }`, `isBuildStale`
- [ ] T025 [US1] Implement `BuildOrchestrator` in `packages/gateway/src/app-runtime/build-orchestrator.ts` — per-slug `Map<slug, Promise<BuildResult>>` mutex, cross-slug concurrency semaphore cap 4, `pnpm install --frozen-lockfile` when lockfile changed, `pnpm build` when source changed, `spawn` with `AbortSignal.timeout(build.timeout * 1000)`, stdout/stderr streamed to `.build.log` capped at 10 MB LRU-truncated, returns `Result<BuildResult, BuildError>` — never throws
- [ ] T026 [US1] Implement trusted-path `installApp()` in `packages/gateway/src/app-runtime/install-flow.ts` — `resolveWithinHome` on all paths, `mkdir({ recursive: true })` + `writeFile({ flag: 'wx' })` for atomic extract, runtime-version compatibility check, delegates to `BuildOrchestrator`, rollback via `rm(targetDir, { recursive: true, force: true })` on any error, verified-path stub throwing `"verified install — phase 3"`, trust-gate stub throwing `"install trust gate — phase 3"` (the gate lands in US3 T080 and wraps the same entry point)
- [ ] T027 [P] [US1] Implement runtime-state composer in `packages/gateway/src/app-runtime/runtime-state.ts` — maps `buildCache.readStamp(slug)` + `processManager.inspect(slug)` into the `ManifestResponse` envelope, caps `stderrTail` at 2 KB and strips any bearer-token substring
- [ ] T028 [US1] Add `GET /api/apps/:slug/manifest` route in `packages/gateway/src/server.ts` — uses `authMiddleware`, `SAFE_SLUG` gate, calls loader + runtime-state + `computeDistributionStatus(manifest.listingTrust, sandboxCapabilities())`, returns `{ manifest, runtimeState, distributionStatus }`, generic 500 with correlation id on internal errors
- [ ] T029 [P] [US1] Create byte-identical session interstitial at `packages/gateway/src/app-runtime/session-interstitial.html` — fixed HTML + 6-line IIFE that derives slug from `location.pathname` regex and `postMessage` to `window.parent` only when `window.parent !== window`, checked in as a fixture and loaded once at module init
- [ ] T030 [US1] Implement `appSessionMiddleware` in `packages/gateway/src/app-runtime/app-session-middleware.ts` — parses `matrix_app_session__{slug}` cookie, verifies HMAC + version + slug match + expiry + scope, injects `c.set("appSession", verified)` on success, `sessionExpiredResponse` picks HTML interstitial or JSON via `Accept` content negotiation, always sets `Matrix-Session-Refresh`, `X-Frame-Options: SAMEORIGIN`, CSP `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'`
- [ ] T031 [US1] Implement bounded ack-token store + `POST /api/apps/:slug/ack` route in `packages/gateway/src/app-runtime/ack-store.ts` and mount in `packages/gateway/src/server.ts` — bearer-authed, asserts `manifest.scope === "personal"` (409 `scope_mismatch`), re-runs `computeDistributionStatus` server-side, 403 `install_blocked_by_policy` on `blocked`, 400 `ack_not_applicable` on `installable`, on `gated` mints an opaque 32-byte random token via `crypto.randomBytes(32).toString("base64url")`, stores it in a bounded LRU keyed by `(slug, principal)` (cap 32, 5-minute TTL, evict on overflow), returns `{ ack, expiresAt }`. The store exposes `consumeAck(slug, principal, ack)` which returns the record and immediately deletes it (one-time), and `peekAck(slug, principal, ack)` which returns the record without deleting (used by the install-flow gate when the same ack token must cover both the session endpoint and the install endpoint in one user flow — ack is consumed by whichever endpoint is called second). `POST /api/apps/:slug/session` and the install-time trust gate both call `peekAck`; only the final caller calls `consumeAck` after their policy check succeeds — document this in a header comment so contributors do not accidentally double-consume.
- [ ] T032 [US1] Add `POST /api/apps/:slug/session` route in `packages/gateway/src/server.ts` — bearer-authed, re-runs `computeDistributionStatus` server-side (ignores any client hint), asserts `manifest.scope === "personal"` (409 `scope_mismatch` otherwise), on `gated` requires a valid ack in the request body via `peekAck(slug, principal, ack)` from T031 (else 409 `install_gated`), refuses `blocked` with 403 `install_blocked_by_policy`, signs a fresh v1 payload and returns `buildSetCookie` with `Path=/apps/{slug}/; HttpOnly; SameSite=Strict; Secure; Max-Age=600`, returns `{ expiresAt }`. Does not `consumeAck` — the install-flow gate (T080) is the single consumer, so the same token survives to cover a follow-up install call in the same user flow.
- [ ] T033 [US1] Update `packages/gateway/src/auth.ts` — define `APP_IFRAME_PREFIXES = ["/apps/"]` (single prefix, no `/files/apps/` entry). When an inbound request's path starts with any prefix in this list, `authMiddleware` calls `next()` immediately without setting a principal and without verifying a bearer header. It does NOT call `appSessionMiddleware` directly — the middleware chain does the routing. Bearer-authed routes (`/api/apps/:slug/manifest`, `/api/apps/:slug/session`, `/api/apps/:slug/ack`, every non-`/apps/*` route) continue to go through the bearer check exactly as before. This is an exemption, not a delegation — the word "delegate" was removed on purpose.
- [ ] T034 [P] [US1] Create thin static file wrapper in `packages/gateway/src/app-runtime/serve-static.ts` that reuses the `/files/*` helper logic from `server.ts:1388-1397` with `resolveWithinHome` on every read — do NOT reimplement content-type sniffing, range requests, or ETag handling
- [ ] T035 [US1] Implement app-runtime dispatcher (static + vite branches) in `packages/gateway/src/app-runtime/dispatcher.ts` — single Hono handler for `/apps/:slug/*`, `SAFE_SLUG` regex gate before any FS access, `loadManifest` dispatch on `manifest.runtime`, static → `serveStaticFileWithin(~/apps/{slug})`, vite → `serveStaticFileWithin(~/apps/{slug}/dist)` with 503 `needs_build` when dist missing, `bodyLimit(10 MB)`, 400 `ws_not_supported` for WebSocket upgrade in static/vite modes, re-reads manifest on every request so live mode migration works without restart
- [ ] T036 [US1] Create `packages/gateway/src/app-runtime/index.ts` public API and mount the middleware chain in `packages/gateway/src/server.ts` in the order `authMiddleware` → `appSessionMiddleware` → `appRuntimeDispatcher` before the existing `/files/*` route. Mount each middleware exactly once. `appSessionMiddleware` only runs for requests whose path starts with `/apps/` because it is mounted on that prefix via Hono's path-based routing; `authMiddleware` exempts the same prefix (T033) so the session middleware is the single verifier for those requests. Non-`/apps/*` routes never touch `appSessionMiddleware`. A regression test (T022) asserts that an `/apps/*` request triggers the session verifier exactly once per request.
- [ ] T037 [P] [US1] Create Vite template in `home/apps/_template-vite/` — `package.json`, `vite.config.ts` with `base: './'` so asset URLs stay relative, `tsconfig.json` strict, `index.html`, `src/main.tsx`, `src/App.tsx` rendering "Hello from Matrix OS" with theme CSS vars, `src/matrix-os.d.ts` typing `window.MatrixOS`, `matrix.json` (`runtime: "vite"`, `runtimeVersion: "^1.0.0"`, `build: { command: "pnpm build", output: "dist" }`), pinned `pnpm-lock.yaml`
- [ ] T038 [P] [US1] Write template build test in `tests/gateway/template-builds.test.ts` — copy `_template-vite` to tmp, run `BuildOrchestrator`, assert `dist/index.html` exists with expected content
- [ ] T039 [P] [US1] Implement client-side manifest cache in `shell/src/lib/app-manifest-cache.ts` — `fetchAppManifest(slug)` with 60s TTL for ready envelopes, 2s TTL for non-ready so UI recovers after retry-build, LRU cap 32, `invalidateManifest(slug)`
- [ ] T040 [P] [US1] Implement `openAppSession(slug, { ack? })` and `requestAckToken(slug)` client wrappers in `shell/src/lib/app-session.ts` — `requestAckToken` calls `POST /api/apps/:slug/ack` and returns the opaque token string; `openAppSession` passes it through as the `ack` field of the session POST
- [ ] T041 [US1] Modify `shell/src/components/AppViewer.tsx` — fetch envelope, branch on `distributionStatus` (blocked → read-only card, gated → ack dialog → `requestAckToken(slug)` → `openAppSession(slug, { ack })`, installable → `openAppSession(slug)`), then branch on `runtimeState.status` (build_failed / process_failed / needs_build error cards vs iframe), always set `iframe.src = "/apps/" + slug + "/"`, install a `window.addEventListener("message")` handler that validates `event.origin === window.location.origin` AND `event.source === iframeRef.current?.contentWindow` AND `data.type === "matrix-os:session-expired"` AND `data.slug === this.props.slug` with 2s debounce, then refreshes session and reassigns `iframe.src`. Do NOT observe `iframe.onload` as a failure probe.
- [ ] T042 [P] [US1] Create `home/agents/skills/pick-app-runtime.md` — decision tree (needs server → node; needs React + build → vite; single HTML blob → static)
- [ ] T043 [P] [US1] Create `home/agents/skills/build-vite-app.md` — scaffold, `matrix.json` conventions, `src/App.tsx` patterns, `useData`/`useKernel`/`useTheme` hooks from `matrix-os/client`, local test via AppViewer
- [ ] T044 [US1] Implement `buildTestGateway()` helper in `tests/helpers/gateway.ts` used by Phase 1 integration test (temp home, install fixtures, `openAppSession` helper, `requestAckToken` helper, `url` and `token` getters, `stop()` cleanup)
- [ ] T045 [US1] Drive Phase 1 integration test in `tests/gateway/app-runtime-phase1.test.ts` to green (install static and vite fixtures, exercise `/apps/:slug/` dispatcher, verify path-scoped cookies, verify manifest API envelope, verify single-verification invariant)
- [ ] T046 [US1] Phase 1 checkpoint — run `bun run lint`, `bun run build`, `bun run test tests/gateway/app-runtime* tests/shell/app-*`, docker smoke-test that the existing 11 static apps still load through the new dispatcher, update `CLAUDE.md` "Active Technologies" + "Recent Changes" sections, run `/update-docs`

**Checkpoint**: US1 is fully functional and testable independently. Spec 060 Wave 2 can now author Vite apps on top of the new runtime.

---

## Phase 4: User Story 2 — Node Runtime (Priority: P2)

**Goal**: Spawn long-running child processes (Next.js blessed template, anything speaking HTTP on `$PORT` works) and reverse-proxy HTTP + WebSocket through the same `/apps/:slug/` dispatcher. Idle shutdown, crash recovery, LRU eviction, graceful gateway shutdown.

**Independent Test**: Install the `hello-next` fixture, open `/apps/hello-next/api/hello` through the gateway, verify a 200 with `{ message: "hello from next" }`. Advance fake timers past `idleShutdown`, verify the process transitions to `idle`. Trigger a crash via `crash-on-request` fixture and verify restart within the backoff budget. Send SIGTERM to the gateway and verify all children drain within 5 s.

### Tests for User Story 2 (written first, must FAIL before implementation)

- [ ] T047 [P] [US2] Write failing port-pool tests in `tests/gateway/app-runtime/port-pool.test.ts` (allocate from range, release + re-allocate, `port_exhausted` `SpawnError`, idempotent release of unknown port, `inUse()` tracking)
- [ ] T048 [P] [US2] Write failing safe-env tests in `tests/gateway/app-runtime/safe-env.test.ts` (strips `CLAUDE_API_KEY`, `CLERK_SECRET_KEY`, `NODE_OPTIONS`; sets `PORT`, `NODE_ENV=production`, `MATRIX_APP_SLUG`, `MATRIX_APP_DATA_DIR`, minimal `PATH`)
- [ ] T049 [P] [US2] Create `tests/fixtures/apps/hello-next/` — minimal Next 16 app with `/api/health` returning `{ ok: true }` and `/api/hello` returning `{ message: "hello from next" }`, pinned lockfile
- [ ] T050 [P] [US2] Create `tests/fixtures/apps/crash-on-request/` — fixture that serves one request then `process.exit(1)`
- [ ] T051 [US2] Write failing process-manager spawn + health-check tests in `tests/gateway/app-runtime/process-manager.test.ts` (spawns with `safeEnv`, transitions `starting` → `healthy` → `running`, `SpawnError('startup_timeout')` when health check never succeeds, `SpawnError('spawn_failed')` on missing binary, updates `lastUsedAt` on success)
- [ ] T052 [US2] Extend process-manager tests with concurrent `ensureRunning` dedup (three parallel callers → one spawn, all receive same `pid`; failure rejects all callers)
- [ ] T053 [US2] Extend process-manager tests with idle-shutdown + LRU eviction using `vi.useFakeTimers` (shuts down after `idleShutdown`, resets timer on `markUsed`, evicts LRU when cap reached)
- [ ] T054 [US2] Extend process-manager tests with crash recovery (exponential backoff 1s/4s/16s, max 3 retries → `failed`, SIGKILL exit code 137 treated as OOM)
- [ ] T055 [US2] Write failing dispatcher node-mode tests in `tests/gateway/app-runtime/dispatcher.test.ts` (forwards GET/POST with body, strips `Server`/`X-Powered-By` response headers, strips every client-controlled forwarded header — `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `X-Matrix-App-Slug` — and sets canonical values from gateway config, 502 with correlation id on backend error, 503 in `failed` state, 504 on 30 s backend timeout, `bodyLimit` 10 MB, awaits `startupPromise` when process is `starting`)
- [ ] T056 [US2] Write failing dispatcher WebSocket tests (node mode only — Next.js fixture that echoes frames, close propagation both ways, 60 s idle timeout, 400 `ws_not_supported` in static/vite modes)
- [ ] T057 [US2] Write failing Phase 2 integration test skeleton in `tests/gateway/app-runtime-phase2.test.ts` (install + build + spawn + proxy, cold start after idle, crash survival, idle shutdown releases port, SIGTERM drains all children)

### Implementation for User Story 2

- [ ] T058 [P] [US2] Implement `PortPool` in `packages/gateway/src/app-runtime/port-pool.ts` — `Set<number>` of available ports in range 40000–49999, cap 100 slots, `allocate()` throws `SpawnError.code = "port_exhausted"`, `release()` idempotent, `inUse()` returns current allocations
- [ ] T059 [P] [US2] Implement `safeEnv({ slug, port, homeDir })` in `packages/gateway/src/app-runtime/safe-env.ts` — whitelist-only construction, explicit `NODE_ENV=production`, minimal `PATH`, `MATRIX_GATEWAY_URL=http://127.0.0.1:4000`, no inherited secrets, no `NODE_OPTIONS`
- [ ] T060 [US2] Implement `ProcessManager` spawn + health check in `packages/gateway/src/app-runtime/process-manager.ts` — `ProcessRecord` map capped at 10, insert `state: "starting"` BEFORE `spawn()`, attach `exit` + `error` handlers before awaiting `startupPromise`, poll `http://127.0.0.1:{port}{healthCheck}` with `AbortSignal.timeout(startTimeout * 1000)`, on failure kill child + release port + transition to `startup_failed`, inject `--max-old-space-size={memoryMb}` into start command, wrap with `prlimit --nofile={maxFileHandles}` on Linux
- [ ] T061 [US2] Implement concurrent `ensureRunning` dedup — store `startupPromise` on `ProcessRecord`, return it to subsequent callers while state is `starting`; rejection propagates to all awaiters
- [ ] T062 [US2] Implement idle shutdown + LRU eviction — `setInterval` reaper at 30 s tick, compare `lastUsedAt` to `idleShutdown`, SIGTERM with 5 s grace → SIGKILL, LRU eviction in `ensureRunning` when slot cap reached
- [ ] T063 [US2] Implement crash recovery in the `child.on("exit")` handler — on `state === "running"` with nonzero exit, transition to `crashed`, schedule restart via `setTimeout(attempt === 0 ? 1000 : attempt === 1 ? 4000 : 16000)`, after 3 failed restarts transition to `failed` + release port + emit `app:failed` event
- [ ] T064 [US2] Extend `packages/gateway/src/app-runtime/dispatcher.ts` with the node-mode branch — lookup `ProcessRecord`, `await processManager.ensureRunning(slug)`, forward method/body/sanitized headers to `http://127.0.0.1:{port}/*` with `AbortSignal.timeout(30000)`, strip the `HOP_BY_HOP` set + all `CLIENT_CONTROLLED_FORWARDED` headers + `X-Matrix-App-Slug`, set canonical `X-Forwarded-Host=cfg.publicHost`/`X-Forwarded-Proto="https"`/`X-Forwarded-Prefix="/apps/{slug}"`, strip `Server`/`X-Powered-By` from upstream response, map errors to 502 (with correlation id, real error server-side only) / 503 / 504, update `lastUsedAt` on every request
- [ ] T065 [US2] Add WebSocket upgrade to dispatcher using `@hono/node-ws` — verify `manifest.runtime === "node"` (else 400 `ws_not_supported`), `ensureRunning`, dial `ws://127.0.0.1:{port}{rest}` with the `ws` library, pipe frames both ways, close downstream on upstream close and vice versa, enforce 60 s idle
- [ ] T066 [P] [US2] Create Next.js template in `home/apps/_template-next/` — `package.json`, `next.config.ts` setting `basePath: \`/apps/${process.env.MATRIX_APP_SLUG}\`` from env, `app/page.tsx`, `app/layout.tsx`, `app/api/health/route.ts` returning `{ ok: true }`, `matrix.json` (`runtime: "node"`, `build: { command: "next build", output: ".next" }`, `serve: { start: "next start", healthCheck: "/api/health", idleShutdown: 300 }`), pinned lockfile
- [ ] T067 [P] [US2] Write Next template build + spawn test in `tests/gateway/next-template.test.ts` (copy template, run install + build + spawn + proxy through gateway, assert response)
- [ ] T068 [P] [US2] Create `home/agents/skills/build-next-app.md` — scaffold, `matrix.json` conventions, `basePath` gotcha, api route patterns, `@matrix-os/client` integration
- [ ] T069 [US2] Wire process manager + graceful shutdown hook into `packages/gateway/src/server.ts` — gateway singleton `ProcessManager`, `SIGTERM` handler drains every running child (SIGTERM → 5 s grace → SIGKILL), clears the `ProcessRecord` map on successful drain
- [ ] T070 [US2] Drive Phase 2 integration test in `tests/gateway/app-runtime-phase2.test.ts` to green (install hello-next, build, spawn, proxy `/api/hello` → 200, fake-timer idle shutdown releases port, crash survival, SIGTERM drains children)
- [ ] T071 [US2] Phase 2 checkpoint — Docker build succeeds (pnpm install works inside container for hello-next), coverage ≥ 95% on new files per constitution, announce unblock to spec 060 Wave 3

**Checkpoint**: US2 is fully functional. Spec 060 can author Next.js apps. US1 continues to work unchanged — static/vite flows never spawn a process.

---

## Phase 5: User Story 3 — Gallery Install Path (Priority: P3)

**Goal**: Publish CLI, verified install path (rebuild + hash compare), runtime version negotiation, and the **install-time `distributionStatus` trust gate** from spec §Install Flow step 6. The session-time gate (US1 T032) and the install-time gate (US3 T080) both call the same `computeDistributionStatus` policy function, ensuring the "gated must be ack-unlockable" invariant holds across both endpoints.

**Independent Test**: `matrix app publish` from the `hello-vite` fixture produces a signed bundle. Installing a `first_party` bundle via the verified path extracts source, rebuilds, hashes `dist/`, compares to declared hash — tampered source yields `BuildError.code = "hash_mismatch"`. Installing a `community` bundle with `ALLOW_COMMUNITY_INSTALLS=0` fails with `ManifestError.code = "install_blocked_by_policy"` (maps to HTTP 403). Installing the same bundle with `ALLOW_COMMUNITY_INSTALLS=1` and no ack fails with `ManifestError.code = "install_gated"` (maps to HTTP 409). Installing with a valid ack token from `POST /api/apps/:slug/ack` (T031) succeeds. Installing an app with `runtimeVersion: "^2.0.0"` against a `1.x` runtime yields a typed version-mismatch error.

### Tests for User Story 3 (written first, must FAIL before implementation)

- [ ] T072 [P] [US3] Write failing publish CLI tests in `tests/cli/app-publish.test.ts` (manifest validation, tar source, tar dist, hash `dist/`, sign bundle, upload stub)
- [ ] T073 [P] [US3] Extend `tests/gateway/app-runtime/install-flow.test.ts` with verified-path tests (rebuild-and-hash on community tier, reject on hash mismatch, trusted-vs-verified branch selection by `listingTrust`)
- [ ] T074 [P] [US3] Write failing install-time trust-gate tests in `tests/gateway/app-runtime/install-flow-trust-gate.test.ts` — covers the full §Install Flow step 6 decision table: `first_party` proceeds, `verified_partner` proceeds, `community` + no flags yields `ManifestError.code = "install_blocked_by_policy"` with no retry possible, `community` + `ALLOW_COMMUNITY_INSTALLS=1` + no ack yields `ManifestError.code = "install_gated"`, `community` + `ALLOW_COMMUNITY_INSTALLS=1` + valid ack (issued by T031, looked up via `peekAck` in the session path and `consumeAck` in the install path) proceeds exactly once (second install attempt with the same token yields `install_gated` because the ack was consumed), `community` + simulated `sandboxEnforced=true` proceeds regardless of the env flag, unknown `listingTrust` fails closed with `install_blocked_by_policy`, a manifest with an authored `distributionStatus` field is rejected with `ManifestError.code = "computed_field_not_authored"` before the gate even runs. Also asserts that `computeDistributionStatus` is the single source of truth by spying on the import — the install gate must not read env flags directly
- [ ] T075 [P] [US3] Write failing runtime-version tests (semver range match accepts compatible, rejects incompatible, missing runtime version treated as pre-1.0)
- [ ] T076 [P] [US3] Write failing install-gate integration test in `tests/gateway/app-runtime-phase3-gate.test.ts` — end-to-end: fetch ack token via `POST /api/apps/:slug/ack`, call the install path, verify the token is consumed exactly once (install succeeds, a second install with the same token is rejected), verify `POST /api/apps/:slug/session` on the same gated app ALSO accepts the same ack token (because the session endpoint calls `peekAck`, not `consumeAck` — the install-flow gate is the single consumer). Captures the session-vs-install ack-sharing contract from T031.

### Implementation for User Story 3

- [ ] T077 [P] [US3] Implement `matrix app publish` in `packages/cli/src/commands/app-publish.ts` — validate manifest against runtime version contract, `pnpm install --frozen-lockfile && pnpm build`, tar `source` + `dist`, hash `dist/`, sign bundle, upload stub (local filesystem store acceptable for the test)
- [ ] T078 [P] [US3] Implement runtime version negotiation in `packages/gateway/src/app-runtime/runtime-version.ts` using the `semver` package — export `RUNTIME_VERSION` constant, `assertRuntimeCompatible(manifest)` called by install flow before the trust gate runs
- [ ] T079 [US3] Extend `packages/gateway/src/app-runtime/install-flow.ts` with the verified path — discard shipped `dist/`, rebuild from source via `BuildOrchestrator`, hash output, compare to publisher's declared hash, fail with `BuildError.code = "hash_mismatch"` on divergence
- [ ] T080 [US3] Implement the install-time trust gate in `packages/gateway/src/app-runtime/install-flow.ts` — new `assertInstallAllowed({ manifest, principal, ack })` helper called at the top of `installApp()` after `assertRuntimeCompatible` and before extraction/build. It calls `computeDistributionStatus(manifest.listingTrust, sandboxCapabilities())` (same policy function US1 T031/T032 uses), throws `ManifestError.code = "install_blocked_by_policy"` on `blocked`, throws `ManifestError.code = "install_gated"` on `gated` unless the caller supplies an ack that `consumeAck(slug, principal, ack)` (from the LRU store in T031) validates and consumes, and proceeds on `installable`. `installApp` now takes an optional `ack` parameter that is threaded through from whatever HTTP route spec 058 mounts. The HTTP status mapping (403/409) is done by the route; this helper throws typed errors. Includes a header-comment block spelling out the shared-ack contract: the session endpoint uses `peekAck` (non-consuming), the install endpoint uses `consumeAck` (terminal). This is the "single gate" promise from spec §Trust tiers: env flags are read exactly once by `sandboxCapabilities()` per call, both endpoints read through the same function, so a `gated` verdict issued by the session endpoint cannot turn into a `blocked` verdict by the time the install endpoint runs (barring an operator toggling `ALLOW_COMMUNITY_INSTALLS` mid-flow, which is documented as undefined behavior).
- [ ] T081 [US3] Replace the `installApp()` trust-gate stub from T026 with a real call to `assertInstallAllowed` and update existing trusted-path tests (T015) to pass `{ ack: undefined }` for first-party fixtures (which resolve to `installable` and do not require an ack)
- [ ] T082 [US3] Phase 3 checkpoint — `matrix app publish` end-to-end against local fixture store, verified install rejects tampered dist, runtime-version mismatch produces a clear shell error, install-time trust gate rejects `blocked`/`gated` community bundles per spec, ack-token sharing contract between session and install endpoints verified by T076

**Checkpoint**: US3 is functional. Spec 058 can deliver gallery-signed bundles to this runtime and the install-time gate enforces the same trust-tier policy as the session-time gate. Spec 025 flipping `community` to `installable` requires zero code changes in this spec once it lands — the single policy function in `distribution-policy.ts` covers every caller.

---

## Phase 6: User Story 4 — Dev Mode Placeholder (Priority: P4)

**Goal**: Accept the `dev: true` manifest flag as advisory metadata so a future spec can land HMR without a schema migration. No runtime behavior in this spec.

**Independent Test**: A manifest with `dev: true` parses without error; the dispatcher still serves `dist/` (no HMR wiring).

- [ ] T083 [US4] Extend Zod manifest schema in `packages/gateway/src/app-runtime/manifest-schema.ts` to accept an optional boolean `dev` field documented as advisory (no enforcement); add one parse-accepts test in `tests/gateway/app-runtime/manifest-schema.test.ts`; document the follow-up spec link in `specs/063-react-app-runtime/spec.md` §Open Questions

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, e2e coverage, and documentation sync across all user stories.

- [ ] T084 [P] Write Playwright e2e test in `tests/e2e/app-runtime.spec.ts` — sign in, open a Vite default app, interact, close, reopen (state persists); open a Node default app, verify cold start, interact, advance fake clock 5 minutes, verify shutdown, reopen verifies cold start; screenshot the build-failed error card
- [ ] T085 [P] Update `CLAUDE.md` "Active Technologies" and "Recent Changes" sections with runtime spec 063 entries and new gateway dependencies (`ws`, `semver`, `glob`)
- [ ] T086 [P] Run `/update-docs` per project guidelines to sync documentation across the repo
- [ ] T087 Run the full Global Done Criteria gate — `bun run test` (unit + integration) all green, `bun run lint` clean, `bun run build` clean, Playwright e2e green in CI, first-open Vite install under 5 s on warm pnpm store, first-request Next.js under 5 s cold / under 100 ms warm, idle shutdown verified in Docker over 10 minutes
- [ ] T088 Archive spec 063 as "complete" in the `specs/` index once all phases are on main

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — T001–T002 unblock everything downstream
- **Foundational (Phase 2)**: T003–T011 depend on Setup. BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational. Independently testable and deployable on merge
- **US2 (Phase 4)**: Depends on Foundational. Independent of US1 at the code level — US2 extends the dispatcher with a new branch and adds the process manager; it does NOT modify US1 code paths. Can land in parallel with spec 060 Wave 2 once US1 merges
- **US3 (Phase 5)**: Depends on US1 (reuses `BuildOrchestrator` + `install-flow` + ack-token store from T031). Can start in parallel with US2 as long as contributors coordinate on `install-flow.ts`. T080 (install-time trust gate) replaces the T026 stub, so it MUST run after T026 has landed
- **US4 (Phase 6)**: Schema-only; can land at any time after Foundational
- **Polish (Phase 7)**: Depends on US1 + US2 + US3 being complete

### User Story Dependencies

- **US1 → no dependency on US2/US3**: foundational phase already delivered manifest schema, loader, distribution policy, app-session primitives. US1 can ship the MVP alone and unblock spec 060 Wave 2. US1 owns the ack-token store (T031) so US3's install gate has a place to hook in
- **US2 → no dependency on US3**: node runtime is feature-complete without the gallery flow; verified install is Phase 3 work
- **US3 → hard dependency on US1**: relies on `BuildOrchestrator`, `install-flow`, and the ack-token store (T031). US2's process manager is not touched by US3
- **US4 → no dependency on US1/US2/US3**: purely additive schema field

### Within Each User Story

- Tests (T004/T006/T008/T010 for Foundational, T012–T023 for US1, T047–T057 for US2, T072–T076 for US3) are written FIRST and must FAIL before implementation begins (CLAUDE.md TDD rule)
- Within a story: foundational types → pure modules → Hono handlers → templates → integration test
- Commits happen after each task (CLAUDE.md "Agents MUST commit progress")

### Single-verification invariant for `/apps/*`

- `authMiddleware` exempts `/apps/*` (T033) by calling `next()` without verification — NOT by calling `appSessionMiddleware` directly
- `appSessionMiddleware` is mounted separately on the `/apps/*` prefix (T036) and is the **single** verifier for those requests
- The auth-exemption regression test (T022) asserts that `/apps/:slug/*` triggers the session verifier exactly once and that non-`/apps/*` routes still go through the bearer check
- Cross-reference for implementers: if you are reading T033 and thinking "why doesn't auth.ts just call appSessionMiddleware?" — because that causes double verification when the chain also mounts `appSessionMiddleware`. Exempt, don't delegate.

### Single-policy invariant for `distributionStatus`

- `computeDistributionStatus` (T009) is the only function that decides `installable` / `gated` / `blocked`
- The session endpoint (T032), the ack endpoint (T031), the manifest API (T028), and the install endpoint's trust gate (T080) all call the same function
- `sandboxCapabilities()` is the only reader of `ALLOW_COMMUNITY_INSTALLS` and the (stubbed) spec-025 flag — the policy function itself is pure
- Ack tokens issued by T031 are shared by the session endpoint (peek) and the install endpoint (consume), so a `gated` verdict at session time cannot become `blocked` at install time under normal operation. Operator env-flag flips mid-flow are documented as undefined behavior

### Parallel Opportunities

- All Foundational tasks marked [P] (T003, T004, T006, T008, T010) can run in parallel — different files
- Within US1, all test-authoring tasks (T012–T023) can run in parallel before any implementation begins (Red phase)
- Within US1, once foundational types land: T024 (build-cache impl), T027 (runtime-state), T029 (interstitial HTML), T034 (serve-static wrapper), T037 (Vite template), T039 (manifest cache), T040 (session+ack client wrappers), T042/T043 (skills) all touch different files and parallelize
- Within US2, T047–T050 (test skeletons + fixtures) run in parallel; T058/T059/T066/T067/T068 (port pool, safe env, Next template, template test, skill) parallelize
- Within US3, all test tasks T072–T076 parallelize; T077 (publish CLI) and T078 (runtime-version) touch different files from T079/T080/T081 (install-flow) and parallelize with them
- Different user stories can be worked on in parallel by different contributors once Foundational completes

---

## Parallel Example: User Story 1 foundation

```bash
# After Foundational (Phase 2) merges, spawn these in parallel:
Task T012: "Build cache tests in tests/gateway/app-runtime/build-cache.test.ts"
Task T013: "hello-vite fixture in tests/fixtures/apps/hello-vite/"
Task T014: "Build orchestrator tests in tests/gateway/app-runtime/build-orchestrator.test.ts"
Task T015: "Install flow tests in tests/gateway/app-runtime/install-flow.test.ts"
Task T017: "App-session middleware tests in tests/gateway/app-runtime/app-session-middleware.test.ts"
Task T018: "Ack-route tests in tests/gateway/app-runtime/ack-route.test.ts"
Task T019: "Dispatcher tests in tests/gateway/app-runtime/dispatcher.test.ts"
Task T020: "Shell manifest cache tests in tests/shell/app-manifest-cache.test.ts"
Task T021: "AppViewer runtime-modes tests in tests/shell/app-viewer-runtime-modes.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T011) — blocks everything
3. Complete Phase 3: US1 (T012–T046)
4. **STOP and VALIDATE**: run Phase 1 integration test + Docker smoke test for existing 11 static apps
5. Ship US1 to main, announce to spec 060 Wave 2 — this is the MVP

### Incremental Delivery

1. Setup + Foundational → runtime primitives on main
2. Add US1 → Vite apps work end-to-end (MVP, unblocks spec 060 Wave 2)
3. Add US2 → Next.js apps work (unblocks spec 060 Wave 3)
4. Add US3 → publish + verified install + install-time trust gate (aligns with spec 058)
5. Add US4 → schema-only dev-mode placeholder
6. Polish → e2e, docs, global done gate

### Parallel Team Strategy

With multiple contributors after Foundational lands:

- Contributor A: US1 (Vite SPA runtime) — MVP critical path
- Contributor B: US2 (node runtime) — starts in parallel once Foundational lands, reviews US1 dispatcher as it merges
- Contributor C: US3 (publish + verified install + install gate) — waits for US1's `install-flow.ts`, `BuildOrchestrator`, and ack-store (T031) to land, then extends
- Integrate checkpoints after each story's phase checklist (T046, T071, T082) to validate independence

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps each task to US1/US2/US3/US4 for traceability against the spec's phase model
- Each user story is independently completable and testable — US1 ships standalone, US2 is a strict superset (extends dispatcher + adds process manager), US3 layers on US1 only
- TDD is non-negotiable: every test task must be committed Red before the matching implementation task is started
- Commit after each task (CLAUDE.md "Agents MUST commit progress")
- Stop at any checkpoint (T046, T071, T082) to validate the current story before starting the next
- Avoid: skipping `resolveWithinHome` on paths, bare `catch { return null }`, `globalThis` for cross-package wiring, mutating manifest-cache state in place, forgetting to strip client-controlled forwarded headers, using `Path=/` on the app session cookie, calling `appSessionMiddleware` from `authMiddleware` (exempt, don't delegate), reading `ALLOW_COMMUNITY_INSTALLS` outside `sandboxCapabilities()`, bypassing `computeDistributionStatus` on the install endpoint
