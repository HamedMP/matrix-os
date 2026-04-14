# CLAUDE.md: Matrix OS

Matrix OS is **Web 4**: a unified AI operating system (OS + messaging + social + AI + games). Claude Agent SDK is the kernel. Everything persists as files. Reachable via web desktop, Telegram, WhatsApp, Discord, Slack, Matrix protocol. Vision: `specs/web4-vision.md`. Website: matrix-os.com

## Constitution

Read `.specify/memory/constitution.md`: the 8 non-negotiable principles. Re-read after compaction.

Key principles:

1. **Everything Is a File**: filesystem is the single source of truth
2. **Agent Is the Kernel**: Agent SDK V1 `query()` with `resume`
3. **Headless Core, Multi-Shell**: core works without UI, shell is one renderer
4. **Defense in Depth (NON-NEGOTIABLE)**: auth matrix, input validation, resource limits, timeouts
5. **TDD (NON-NEGOTIABLE)**: tests first, 99-100% coverage target

## Tech Stack

- **Runtime**: Node.js 24+, TypeScript 5.5+ strict, ES modules
- **AI**: Claude Agent SDK V1 `query()` + `resume`, Opus 4.6
- **Frontend**: Next.js 16 (`proxy.ts` replaces middleware, Turbopack, React Compiler, `cacheComponents`), React 19
- **Backend**: Hono (HTTP/WS gateway + channel adapters)
- **Database**: SQLite/Drizzle ORM (kernel), Postgres/Kysely (social/app data)
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
- **Conventional Commits**: `feat:`, `fix:`, `test:`, `chore:`, `ci:`, `docs:`, `refactor:`
- **Specs go in `specs/`**: NEVER `docs/plans/`. Format: `specs/{NNN}-{feature-name}/`
- **Drizzle ORM only**: never raw SQL with better-sqlite3
- **Kernel prompt**: keep under 7K tokens
- **Spike before spec**: test undocumented SDK behavior with throwaway code first
- **Verify Before Done**: always check for lint errors and build errors after making changes. Run `bun run lint` and `bun run build` (or check the dev server output) before considering a change complete. Never leave broken references, unused imports, or type errors.
- After major features: run `/update-docs` to sync all documentation

## Mandatory Code Patterns

These patterns were identified as recurring defects across 4+ PRs (~317 unresolved review comments). Violations are the #1 source of bugs. Full analysis: `docs/dev/pr-review-analysis.md`

### Atomicity

- **2+ related DB writes MUST use a transaction**. No exceptions. Like + counter, delete + cascade, insert + update are all multi-step.
- **Use `ON CONFLICT` for idempotent upserts** instead of check-then-insert (TOCTOU race).
- **Use `{ flag: 'wx' }` for exclusive file creates** instead of `existsSync` + `writeFile`.

### External Calls

- **Every `fetch()` to an external service MUST have `signal: AbortSignal.timeout(ms)`**. Default: 10s for APIs, 30s for file downloads. No external call may hang indefinitely.
- **Never expose provider names or raw error messages to clients**. Log the real error server-side, return a generic message. This includes Postgres errors, Twilio/ElevenLabs/OpenAI errors, and filesystem paths.

### Input Validation

- **Use Hono `bodyLimit` middleware** on every mutating endpoint. Never check Content-Length after the body is already buffered.
- **Validate and sanitize all user-supplied values** before using in file paths, SQL identifiers, or API URLs. Use `resolveWithinHome` for paths, `SAFE_SLUG` regex for identifiers.
- **No wildcard CORS** (`Access-Control-Allow-Origin: *`). Use explicit origin allowlist.

### Resource Management

- **Every in-memory Map/Set MUST have a size cap and eviction policy**. No unbounded growth. Cap + LRU eviction or TTL-based cleanup.
- **Every temp file MUST have a cleanup policy** (TTL, max count, or explicit deletion after use).
- **`appendFileSync`/`writeFileSync` are banned in request handlers**. Use async `fs/promises` to avoid blocking the event loop.

### Error Handling

- **No bare `catch { return null }`**. Every catch must check error type -- DB connection failures and timeouts are not "not found."
- **No `catch { }` (empty catch)**. At minimum, log the error.
- **Webhook handlers must return appropriate status codes** -- 200 only on success, 4xx/5xx on failure so providers retry correctly.

### Wiring Verification

- **Every IPC tool must resolve its dependency at registration time**, not at call time. If a tool needs `callManager`, verify it's not `undefined` when the tool is registered.
- **Never use `globalThis` for cross-package communication**. Use dependency injection or typed IPC messages.

## Running

```bash
pnpm install              # install deps
bun run test              # unit tests
bun run dev               # gateway (:4000) + shell (:3000)
bun run docker            # Docker dev (primary, requires OrbStack on macOS)
bun run docker:full       # + proxy, platform, conduit
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

Full guide: `docs/dev/review-pipeline.md`. Three-pass structure, not line-by-line.

### Pre-PR Checklist

Before opening any PR, run:

```bash
bun run typecheck           # tsc --noEmit for all packages
bun run check:patterns      # CLAUDE.md pattern scanner
bun run test                # unit tests
```

### Three Review Passes

1. **Mechanical CLAUDE.md sweep**: bare catch, fetch without signal, missing bodyLimit, unbounded Map/Set, sync file I/O. Mostly automated by `scripts/review/check-patterns.sh`.
2. **Trust-boundary sweep**: trace external input through route handlers, filesystem ops, DB queries, WS/IPC handlers. Apply per-file-type checklists.
3. **Atomicity/failure-mode review**: source of truth, lock scope, partial failure, shutdown cleanup, deferred scope.

### PR Size Limits

- **> 3000 additions or > 50 files**: split the PR
- Split boundaries: gateway, platform, sync-client, shell, docs/deploy

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

- TypeScript 5.5+ strict, ES modules + node-pty (backend), @xterm/xterm + addon-webgl + addon-search + addon-serialize + addon-fit (frontend), Hono WebSocket (gateway), Zod 4 (validation) (056-terminal-upgrade)
- Files — `~/system/terminal-sessions.json` (session metadata), `~/system/terminal-layout.json` (layout with sessionId) (056-terminal-upgrade)
- App runtime — Vite + React SPA (static/vite), Next.js node runtime (node), process manager, reverse proxy, HMAC-signed per-app cookies; gateway deps: semver, glob (063-react-app-runtime)

## Recent Changes

- 063-react-app-runtime: React app runtime with three modes (static, vite, node), build orchestrator with source-hash caching, process manager with idle shutdown, pnpm install flow, distribution policy (owner-only/installable/featured), HMAC-signed per-app auth cookies, CLI publish command
- 056-terminal-upgrade: Added TypeScript 5.5+ strict, ES modules + node-pty (backend), @xterm/xterm + addon-webgl + addon-search + addon-serialize + addon-fit (frontend), Hono WebSocket (gateway), Zod 4 (validation)

# SlayZone Environment

You are running inside [SlayZone](https://slayzone.com), a desktop development environment built around a kanban board. Each task on the board is a full workspace with terminal panels, a file editor, a browser panel, and git integration. Your session is one of potentially many agents working in parallel on different tasks. A human or another agent may interact with you through the terminal.

Your task has a title, description, status, and subtasks — use the `slay` CLI to read and update them. See the `slay` skill for the full command reference.

`$SLAYZONE_TASK_ID` is set to the ID of the task you are running inside. Most `slay` commands default to it when no explicit ID is given.
