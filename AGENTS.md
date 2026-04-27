# AGENTS.md: Matrix OS

Matrix OS is **Web 4**: a unified AI operating system (OS + messaging + social + AI + games). Claude Agent SDK is the kernel. Everything persists as files. Reachable via web desktop, Telegram, WhatsApp, Discord, Slack, Matrix protocol. Vision: `specs/web4-vision.md`. Website: matrix-os.com

## Constitution

Read `.specify/memory/constitution.md`: the 9 core principles. Re-read after compaction.

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
- **Database**: PostgreSQL via Kysely for platform, kernel durable state, social, app, and user data. Do not add SQLite/Drizzle/better-sqlite3 for new persistence.
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
- **Kysely/Postgres only**: never add SQLite, Drizzle ORM, or better-sqlite3 for new persistence
- **Kernel prompt**: keep under 7K tokens
- **Spike before spec**: test undocumented SDK behavior with throwaway code first
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
# Edit .env.docker -- set ANTHROPIC_API_KEY
bun run docker       # start dev environment
```

Without Flox: install Node 24+, pnpm 10, bun manually, then `pnpm install`. Full guide: `docs/dev/onboarding.md`

## Project Structure

| Directory | What it is |
|-----------|------------|
| `packages/kernel/` | AI kernel -- Agent SDK, agents, hooks, SOUL, skills |
| `packages/gateway/` | Hono HTTP/WS gateway, channel adapters, cron |
| `packages/platform/` | Multi-tenant orchestrator (Clerk auth, Docker provisioning) |
| `packages/proxy/` | Shared API proxy, usage tracking |
| `packages/ui/` | Shared UI components |
| `shell/` | Next.js 16 desktop shell frontend |
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

bun run dev               # local dev: gateway + proxy + shell
bun run dev:gateway       # gateway only
bun run dev:shell         # shell only
bun run dev:proxy         # proxy only
bun run dev:platform      # platform only
bun run dev:www           # matrix-os.com website only
bun run dev:kernel        # kernel package only

bun run docker            # Docker dev (primary, requires OrbStack on macOS)
bun run docker:full       # + proxy, platform, conduit
bun run docker:all        # + observability stack
bun run docker:multi      # + alice & bob multi-user
bun run docker:stop       # stop containers, preserve volumes
bun run docker:restart    # restart dev container
bun run docker:logs       # tail dev container logs
bun run docker:shell      # shell into container as matrixos user
bun run docker:build      # full rebuild (no cache)
```

**IMPORTANT**: Never `docker compose down -v` unless explicitly resetting. Volumes hold OS state, node_modules, and .next cache.
**IMPORTANT**: Always run `pnpm install` from the repo root after adding/removing dependencies to update `pnpm-lock.yaml`. Vercel deployments fail on stale lockfiles.

## Shell Gotchas

- **Never mutate state in reducers**: `reduceChat` etc. must create new objects via spread, not mutate in-place. Shallow copies share refs; mutating causes streaming text duplication.
- **Never use `meta.icon` as image URL**: always use generated PNG at `/files/system/icons/{slug}.png`
- **Never cache-bust with `?t=Date.now()`**: use ETag-based `?v={etag}` only when file changes
- **Reset `imgFailed` when `iconUrl` changes**: track prev URL with `useRef`, reset on differ
- **Cloudflare overrides `Cache-Control`**: use `CDN-Cache-Control` header to control Cloudflare independently
- **Shell changes need Docker rebuild**: shell is built into the image. `docker compose up --build` only rebuilds platform/proxy.
- **`docker build` needs `--build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...`**

## UX Guide

Read `specs/ux-guide.md`. Key rules:

1. Toggle consistency: click to open, click same spot to close. Light dismiss. Escape.
2. No layout shift: transient panels overlay, never push content.
3. Spatial memory: window positions persist across reloads.
4. Progressive disclosure: clean defaults, details one click away.
5. Empty states are onboarding: icon + headline + description + CTA.

## Spec Quality Gates

Every spec with endpoints/WebSockets/IPC/file I/O must include: security architecture (auth matrix, input validation, error policy), integration wiring (startup sequence, cross-package comms), failure modes (timeouts, concurrent access, crash recovery), resource management (buffer limits, file cleanup). Full checklist: `specs/quality-gates.md`

## Code Review Pipeline

Full guide: `docs/dev/review-pipeline.md`. Use three structured passes, not line-by-line review.

### Pre-PR Checklist (mandatory)

```bash
bun run typecheck           # tsc --noEmit for all packages
bun run check:patterns      # CLAUDE.md pattern scanner (scripts/review/check-patterns.sh)
bun run test                # unit tests
```

### Three Review Passes

1. **Mechanical CLAUDE.md sweep**: Run `bun run check:patterns` and fix all violations. The scanner checks: bare catch, fetch without signal, sync file I/O, unbounded Map/Set. Warnings (bodyLimit, path ops, external headers) require manual verification.

2. **Trust-boundary sweep**: For each changed file, classify it (route handler, filesystem, database, WS/IPC) and apply the matching checklist from `docs/dev/review-pipeline.md`. Trace external input from entry to use.

3. **Atomicity/failure-mode review**: For each subsystem touched, answer: What is the source of truth? What is inside the lock/transaction? What happens on partial failure? What happens on shutdown? What is explicitly deferred?

### PR Size Limits

- **> 3000 additions or > 50 files**: split the PR
- Split along: gateway, platform, sync-client, shell, docs/deploy

### PR Body: Mandatory Invariants

Every backend PR must include an "Invariants" section:

- **Source of truth**: which store is canonical, how divergence is reconciled
- **Lock/transaction scope**: what is inside the critical section, are network calls inside or outside
- **Acceptable orphan states**: what happens if step N+1 fails after step N succeeds
- **Auth source of truth**: primary auth mechanism, fallback behavior
- **Deferred scope**: what is explicitly NOT in scope -- say so, don't leave dead code

### Branch Freeze

Do not request review while still pushing commits. Either declare a review commit range or mark the PR as ready and stop pushing.

### Hard Rules (never violate)

- No bare `catch {}` or `.catch(() => {})` -- every catch must check error type and log
- No `fetch()` without `signal: AbortSignal.timeout()` -- 10s APIs, 30s downloads
- No `writeFileSync`/`appendFileSync` in request handlers -- use `fs/promises`
- No unbounded `Map`/`Set` without size cap and eviction
- No `path.join()` on unvalidated external input -- use `resolveWithinPrefix`
- No raw error messages or Zod `.issues` in client responses
- No PR larger than 3000 additions or 50 files without splitting

## Reference Docs

Read these on demand, not every session:

- `docs/dev/review-pipeline.md` -- when reviewing or opening PRs (three-pass structure, checklists, CI gates)
- `docs/dev/onboarding.md` -- developer setup, API keys, and getting started
- `docs/dev/pr-review-analysis.md` -- when triaging review comments or understanding recurring defect patterns
- `docs/dev/docker-development.md` -- when working on Docker setup or debugging container issues
- `docs/dev/vps-deployment.md` -- when deploying to production or managing the VPS
- `docs/dev/releases.md` -- when tagging a release or managing versions
- `specs/quality-gates.md` -- when writing a new spec or reviewing a PR
- `specs/ux-guide.md` -- when working on shell/frontend UI
- `.specify/memory/constitution.md` -- when making architectural decisions (re-read after compaction)

## Swarm / Multi-Agent Rules

- **NEVER use worktree isolation** (`isolation: "worktree"` is BANNED) -- worktrees lose uncommitted changes
- **Agents MUST commit progress** after each phase/feature
- **NEVER call TeamDelete** -- team files are cheap, lost work is expensive
- Agents work on current branch in parallel, no feature branches

## Active Technologies
- TypeScript 5.5+ strict, ES modules, Node.js 24+, React 19, Next.js 16 + Hono, Zod 4 via `zod/v4`, Kysely/Postgres for user app/workspace data, existing terminal stack (`node-pty`, `@xterm/xterm`), `@tldraw/tldraw` for the shell canvas renderer (071-tldraw-workspace-canvas)
- User-owned Postgres workspace tables for canonical canvas documents and references; filesystem export/backup integration under `~/system/` or project export bundles where required by recovery flows (071-tldraw-workspace-canvas)

- TypeScript 5.5+ strict, ES modules + node-pty (backend), @xterm/xterm + addon-webgl + addon-search + addon-serialize + addon-fit (frontend), Hono WebSocket (gateway), Zod 4 (validation) (056-terminal-upgrade)
- Files — `~/system/terminal-sessions.json` (session metadata), `~/system/terminal-layout.json` (layout with sessionId) (056-terminal-upgrade)

## Recent Changes

- 056-terminal-upgrade: Added TypeScript 5.5+ strict, ES modules + node-pty (backend), @xterm/xterm + addon-webgl + addon-search + addon-serialize + addon-fit (frontend), Hono WebSocket (gateway), Zod 4 (validation)

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read:
`specs/071-tldraw-workspace-canvas/plan.md`
<!-- SPECKIT END -->
