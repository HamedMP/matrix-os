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

## Code Review Essentials

Check failure modes, not just happy paths:

- **Error handling**: typed catch blocks (not bare `catch { return null }`), async `.catch()`, no leaking internals
- **Atomicity**: 3+ sequential DB writes need transactions, no TOCTOU races
- **API contract**: response field names match frontend, no dead code paths
- **Type safety**: no unchecked `as` casts, sync/async signature matches

## Reference Docs

Read these on demand, not every session:

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

## Recent Changes

- 056-terminal-upgrade: Added TypeScript 5.5+ strict, ES modules + node-pty (backend), @xterm/xterm + addon-webgl + addon-search + addon-serialize + addon-fit (frontend), Hono WebSocket (gateway), Zod 4 (validation)
