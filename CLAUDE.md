# CLAUDE.md: Matrix OS

## What This Is

Matrix OS is **Web 4**: a unified AI operating system that combines OS, messaging, social media, AI assistants, and games into a single platform. The Claude Agent SDK serves as the kernel. The system generates software from natural language, persists everything as files, heals/evolves itself, and is reachable through multiple channels (web desktop, Telegram, WhatsApp, Discord, Slack, Matrix protocol).

**Website**: matrix-os.com

### The Web 4 Vision

- Runs on ALL your devices (laptop, phone, cloud): peer-to-peer git sync, no central server
- Federated identity via Matrix protocol: `@user:matrix-os.com` (human) / `@user_ai:matrix-os.com` (AI)
- AI-to-AI communication via Matrix custom events (modern email: AIs negotiate meetings, share data)
- Social layer: profiles, feeds, friends/family with privilege levels, aggregate existing platforms
- App marketplace: build, share, monetize apps (including multiplayer games with leaderboards)
- Security: "call center" model for external AI access (sandboxed context, not full account access)
- Full vision: `specs/web4-vision.md`

## Constitution (Source of Truth)

Read `.specify/memory/constitution.md`: it defines the 6 non-negotiable principles and all tech constraints. Re-read it after compaction or on new sessions.

Key principles:
1. **Everything Is a File**: file system is the single source of truth
2. **Agent Is the Kernel**: Claude Agent SDK V1 `query()` with `resume` IS the kernel
3. **Headless Core, Multi-Shell**: core works without UI, shell is one renderer
4. **Self-Healing and Self-Expanding**: OS patches itself, creates new capabilities
5. **Simplicity Over Sophistication**: simplest implementation that works
6. **TDD (NON-NEGOTIABLE)**: tests first, 99-100% coverage target

## Architecture Specs

### Vision & North Star
- `specs/web4-vision.md`:**Web 4 vision document** (the north star)
- `specs/matrixos-vision.md`: original vision doc

### Active Specs (current work)
- `specs/004-concurrent/`: Phase 7: Multiprocessing (T053-T056, T053 serial queue is pre-req for 006)
- `specs/005-soul-skills/`: Phase 9: SOUL identity + skills (T100-T105, T100i-T100j audit fixes)
- `specs/006-channels/`: Phase 10: Multi-channel messaging (T106-T119)
- `specs/007-proactive/`: Phase 11: Cron + heartbeat (T120-T129)
- `specs/008-cloud/`: Phase 12: Cloud deployment (T130-T136, T140-T159)
- `specs/009-platform/`: Web 4 platform: identity, sync, mobile, marketplace, games (T200-T261)
- `specs/010-demo/`: Phase 8: Demo polish + recording (T057-T064)
- `specs/011-new-computing/`: New computing paradigms: Living Software, Socratic Computing, Intent-based (T300-T317)
- `specs/012-onboarding/`: Personalized onboarding: role discovery, setup proposal, multi-agent provisioning (T400-T412)
- `specs/013-distro/`: Linux distro + Docker deployment: Dockerfile, mkosi, systemd, cage kiosk (T500-T517)
- `specs/025-security/`: Security hardening: content wrapping, SSRF, audit, sandbox, outbound queue (T800-T849)
- `specs/026-web-tools/`: Web fetch + search: Cloudflare Markdown, Readability, Brave/Perplexity/Grok (T850-T869)
- `specs/027-expo-app/`: Expo mobile app: chat, mission control, push notifications (T870-T899)
- `specs/028-browser/`: Browser automation: Playwright MCP, role snapshots, composite tool (T900-T929)
- `specs/029-plugins/`: Plugin system: manifest, API, hooks (void + modifying), security (T930-T969)
- `specs/030-settings/`: Settings dashboard: agent, channels, skills, security, cron, plugins (T970-T999)
- `specs/031-desktop-customization/`: Desktop customization: theme presets, backgrounds, dock config, settings UI (T1000-T1007)
- `specs/032-e2e-testing/`: E2E test suite for gateway HTTP/WS endpoints (T1100-T1119)
- `specs/033-docs/`: Public documentation site: Fumadocs in www/, developer + user guides (T1100-T1108)
- `specs/034-observability/`: Container observability: Prometheus metrics, Grafana dashboards, Loki logs, alerting (T1200-T1229)
- `specs/035-canvas-desktop/`: Canvas desktop mode: infinite pan/zoom canvas, app grouping, minimap (T1250-T1279)

- `specs/044-docker-dev/`: Docker-primary local development: non-root user, su-exec, identity from env, convenience scripts
- `specs/046-voice/`: Voice interface (spec drafted)
- `specs/047-terminal/`: IDE-grade terminal app with Claude Code integration (COMPLETE)
- `specs/048-file-browser/`: File browser app (spec drafted)

### Archive (Phases 1-6 complete)
- `specs/003-architecture/`: original architecture spec, plan, tasks (reference only)
- `specs/003-architecture/SDK-VERIFICATION.md`: SDK assumption verification
- `specs/003-architecture/KERNEL-AND-MEMORY.md`: kernel and memory architecture detail

## Reference Docs

- `docs/agent-sdk/`: Claude Agent SDK documentation
- `docs/claude-code-docs/`: Claude Code documentation
- `docs/opus-4.6.md`: Opus 4.6 features (adaptive thinking, effort, compaction, fast mode, 128K output, 1M context)
- `docs/context-window.md`: context window management, 1M beta, compaction
- `docs/prompt-caching.md`: prompt caching strategy (90% savings on repeated content)
- `docs/anthropic-ts-sdk-reference.md`: Anthropic TypeScript SDK reference

## Tech Stack

- **Language**: TypeScript 5.5+, strict mode, ES modules
- **Runtime**: Node.js 24+
- **AI**: Claude Agent SDK V1 `query()` with `resume` + Opus 4.6
- **Frontend**: Next.js 16, React 19
- **Backend**: Hono (HTTP/WebSocket gateway + channel adapters)
- **Channels**: node-telegram-bot-api, @whiskeysockets/baileys, discord.js, @slack/bolt
- **Federation**: Matrix protocol (matrix-js-sdk): federated identity, AI-to-AI, E2E encryption
- **Database**: SQLite via Drizzle ORM (better-sqlite3, WAL mode)
- **Validation**: Zod 4 (`zod/v4` import)
- **Scheduling**: node-cron (cron expressions), native timers
- **Testing**: Vitest (TDD, 99-100% coverage, `@vitest/coverage-v8`)
- **Package Manager**: pnpm (install), bun (run scripts): NEVER npm

## Project Structure

```
packages/kernel/     # AI kernel (Agent SDK, agents, IPC, hooks, SOUL, skills)
packages/gateway/    # Hono HTTP/WebSocket gateway + channels + cron + heartbeat
packages/platform/   # Multi-tenant orchestrator (Hono :9000, Drizzle, dockerode)
packages/proxy/      # Shared API proxy (Hono :8080, usage tracking)
shell/               # Next.js 16 frontend (desktop shell: one of many shells)
www/                 # matrix-os.com + /docs (Next.js on Vercel, Clerk auth, Inngest, Fumadocs)
home/                # File system template (copied on first boot)
tests/               # Vitest test suites
spike/               # Throwaway SDK experiments
specs/               # Architecture specs
docs/                # Reference documentation
distro/              # Docker, cloudflared, systemd deployment configs
```

## SDK Decisions (Spike-Verified)

- V1 `query()` with `resume`: V2 silently drops mcpServers, agents, systemPrompt
- `createSdkMcpServer()` + `tool()` for in-process MCP tools (Zod 4 schemas)
- `allowedTools` is auto-approve, NOT filter: use `tools`/`disallowedTools` to restrict
- `AgentDefinition` v0.2.39+: includes `maxTurns`, `disallowedTools`, `mcpServers`, `skills` per agent
- `bypassPermissions` propagates to ALL subagents: use PreToolUse hooks for access control
- **Agent SDK bundles its own claude runtime** -- no separate `npm install -g @anthropic-ai/claude-code` needed
- **bypassPermissions refuses root** -- Docker containers must run services as non-root user
- Prompt caching: `cache_control: {type: "ephemeral"}` on system prompt + tools for 90% savings
- Integration tests use haiku to keep costs <$0.10 per run

## Running the Platform

### Prerequisites
- Node.js 24+
- pnpm (`corepack enable && corepack prepare pnpm@latest --activate`)
- `ANTHROPIC_API_KEY` env var set (for kernel AI features)

### Install
```bash
pnpm install
```

### Run Tests
```bash
bun run test              # Unit tests (1942 tests, ~16s)
bun run test: watch        # Watch mode
bun run test: integration  # Integration tests (needs API key, uses haiku)
bun run test: coverage     # Coverage report
```

### Start Development Servers
```bash
# All at once (gateway + shell):
bun run dev

# Or individually:
bun run dev: gateway   # Hono gateway on http://localhost:4000
bun run dev: shell     # Next.js shell on http://localhost:3000
```

The gateway boots the home directory at `~/matrixos/` on first run (copies from `home/` template, initializes git).

### Docker Development (Primary)

Requires [OrbStack](https://orbstack.dev) on macOS. See `docs/dev/docker-development.md` for full guide.

**IMPORTANT**: Never use `docker compose down -v` (removes volumes) unless explicitly resetting to clean state. Volumes hold the OS home directory, node_modules, and .next cache -- losing them means reinstalling deps and losing all OS state.

```bash
bun run docker          # Dev only (gateway + shell with HMR)
bun run docker:full     # + proxy, platform, conduit
bun run docker:all      # + observability (Grafana, Prometheus, Loki)
bun run docker:multi    # + alice & bob multi-user
bun run docker:stop     # Stop all containers (preserves data)
bun run docker:restart  # Restart dev container
bun run docker:logs     # Tail dev container logs
bun run docker:shell    # Shell into container as matrixos user
bun run docker:build    # Full rebuild (no cache)
```

**Service URLs** (full + obs profile):

| Service | URL | Port |
|---------|-----|------|
| Shell (desktop) | http://localhost:3000 | 3000 |
| Gateway (API) | http://localhost:4000 | 4000 |
| Proxy | http://localhost:8080 | 8080 |
| Platform | http://localhost:9000 | 9000 |
| Conduit (Matrix) | http://localhost:6167 | 6167 |
| Prometheus | http://localhost:9090 | 9090 |
| Grafana | http://localhost:3200 | 3200 |
| Loki | http://localhost:3100 | 3100 |

### Environment Variables
- `ANTHROPIC_API_KEY`: required for kernel AI features
- `MATRIX_HOME`: custom home directory path (default: `~/matrixos/`)
- `MATRIX_HANDLE`: user handle, set by platform at provisioning (default in Docker: `dev`)
- `MATRIX_DISPLAY_NAME`: display name from Clerk signup (default in Docker: `Developer`)
- `MATRIX_AUTH_TOKEN`: bearer token for web shell auth (optional, for cloud deployment)
- `PORT`: gateway port (default: 4000)
- `NEXT_PUBLIC_GATEWAY_WS`: shell WebSocket URL (default: `ws://localhost:4000/ws`)
- `NEXT_PUBLIC_GATEWAY_URL`: shell HTTP URL (default: `http://localhost:4000`)
- `GATEWAY_URL`: Next.js proxy target (default: `http://localhost:4000`)
- Channel tokens are configured in `~/matrixos/system/config.json` (Everything Is a File)

### Architecture
```
Browser (localhost:3000)              Telegram / WhatsApp / Discord / Slack
  |-- Next.js shell (desktop UI)        |-- Channel adapters (polling/websocket)
  |-- proxy.ts rewrites to gateway      |
  |                                     |
  +------------- Gateway (localhost:4000) ---------------+
                  |-- /ws           Main WebSocket (chat, file watcher events)
                  |-- /ws/terminal  PTY WebSocket (xterm.js <-> node-pty)
                  |-- /api/message  REST endpoint for kernel messages
                  |-- /api/channels/status  Connected channel status
                  |-- /files/*      Serve home directory files
                  |-- /modules/*    Reverse proxy to module ports (3100-3999)
                  |-- /api/theme    Current theme JSON
                  |-- /api/conversations  Conversation list metadata
                  |-- /api/layout   GET/PUT window layout persistence
                  |-- /api/bridge/data    App data read/write (scoped to ~/data/{appName}/)
                  |-- /api/cron     GET cron job list
                  |-- /api/tasks    GET list + POST create tasks
                  |-- /health       Health check
                  |
                  |-- ChannelManager  (starts/stops channel adapters)
                  |-- CronService     (scheduled tasks from ~/system/cron.json)
                  |-- HeartbeatRunner (periodic kernel invocation)
                  |
                  +---> Dispatcher ---> Kernel (Agent SDK)
```

## Current State (updated per commit)

**Tests**: 2187+ passing (170+ test files) | **Through Phase 047 Terminal + Phase 044 Docker-primary dev + Phase 031 desktop customization + Phase 025 security + Phase 009 P1 identity + Phase 009 P0 + Phase 008A/008B + Phase 007 + Phase 004 + Phase 012**

### Completed
- **Phase 1**: Monorepo, pnpm workspaces, Vitest, TypeScript strict
- **Phase 2**: SQLite/Drizzle schema, system prompt builder, agent frontmatter parser, first-boot
- **Phase 3**: Kernel (spawnKernel with V1 query+resume), IPC MCP server (8 tools incl load_skill), hooks (8 hooks incl gitSnapshotHook), gateway (Hono HTTP+WS, dispatcher with serial queue, file watcher), agent prompts (builder, researcher, deployer, healer, evolver: in home/agents/custom/)
- **Phase 4**: Next.js 16 shell: Desktop, ChatPanel, AppViewer, Dock, ActivityFeed, Terminal, ModuleGraph, OS bridge, InputBar, ResponseOverlay, window persistence, message queuing
- **Phase 5**: Self-healing: heartbeat loop, healer sub-agent, backup/restore, activity.log, healing-strategies.md
- **Phase 6**: Self-evolution: protected files hook, watchdog, evolver prompt
- **Phase 004**: Serial dispatch queue (T053), concurrent dispatch with maxConcurrency (T054), process registration in tasks table (T055), active process conflict avoidance in system prompt (T056)
- **Phase 005**: SOUL identity system (soul.md, identity.md, user.md, bootstrap.md), skills system (loadSkills, buildSkillsToc, load_skill IPC tool, 4 starter skills), agent prompt files in home/agents/custom/, createGitSnapshotHook, estimateTokens
- **Phase 006**: Multi-channel messaging: ChannelAdapter interface, ChannelManager lifecycle, formatForChannel (Telegram/Discord/Slack/WhatsApp), Telegram adapter (polling, allowFrom), channel-aware dispatcher (DispatchContext), /api/channels/status, channel-routing knowledge file, channels config in config.json
- **Phase 007**: Cron + Heartbeat: CronService (interval/once/cron schedules via node-cron), CronStore (atomic JSON persistence), manage_cron IPC tool, HeartbeatRunner (periodic kernel invocation with active hours), heartbeat prompt builder, wired into gateway startup/shutdown, cron.json hot-reload via file watcher, heartbeat config in config.json
- **Phase 008A**: Single-user cloud: Dockerfile (multi-stage Alpine), docker-compose.yml, systemd service, auth middleware (MATRIX_AUTH_TOKEN bearer), setup-server.sh, /api/system/info endpoint
- **Phase 009 P0**: Observability + Safety: interaction logger (JSONL daily rotation, prompt truncation, cost tracking), GET /api/logs query endpoint, safe mode agent (sonnet, restricted tools, diagnostic prompt), logs directory template
- **Phase 009 P1 Identity**: Handle registry (handle.json), loadHandle/saveIdentity/deriveAiHandle, profile.md + ai-profile.md templates, handle injection into system prompt, GET /api/profile + /api/ai-profile endpoints
- **Phase 012**: Onboarding: persona engine (7 roles + keyword matching), setup plan (Zod schema), provisioner (batch dispatch + kanban task board), IPC tools, skill templates (study-timer, budget-helper), bootstrap.md flow, system prompt integration, Mission Control (kanban/grid toggle, cron section, add task, AppTile, TaskDetail, ui: cards/ui: options/ui: status blocks, zustand preferences), Cmd+K command palette (shadcn CommandDialog, Zustand command registry, global keyboard shortcuts)
- **Phase 009 P1 Sync+Mobile**: Git sync (auto-sync, sync_files IPC tool), mobile responsive shell, PWA manifest
- **Phase 008B**: Multi-tenant platform: platform service (Hono :9000, Drizzle, dockerode orchestrator, lifecycle manager, social API), Clerk auth + Inngest provisioning in www/, admin dashboard, Cloudflare Tunnel + docker-compose.platform.yml
- **Phase 031**: Desktop customization: 6 theme presets, background system (pattern/solid/gradient/wallpaper), dock config (position/size/autoHide), Appearance settings UI, chat-driven customization via knowledge file. 38 tests (5 test files).
- **Phase 047**: IDE-grade terminal app: tabs, split panes, file tree sidebar with git status, adaptive theming, Claude Code launch button. Standalone windows (multiple instances) + bottom panel. Dev container: zsh + Claude Code CLI. 51 tests (5 test files).

### In Progress
- **013A Docker** (T500-T506): Dockerfile + docker-compose.yml done. User working on additional distro scaffolding.
- **033 Docs** (T1100-T1108): Fumadocs documentation site at www/content/docs/ (feat/docs-site branch)

### Next Up (see specs/ for details)
- **034 Observability** (T1200-T1229): Prometheus metrics, Grafana dashboards, Loki log aggregation, alerting
- **035 Canvas Desktop** (T1250-T1279): Infinite pan/zoom canvas mode, app grouping, minimap, toolbar
- **011 New Computing** (T300-T317): Living Software, Socratic Computing, Intent-based Interfaces
- **013B Distro** (T510-T517): mkosi, systemd services, Plymouth, Raspberry Pi
- **010 Demo** (T057-T064): pre-seed apps, demo script, recording

### Deferred (lower priority within completed phases)
- **006**: WhatsApp (T113-T114), Discord (T115), Slack (T116) adapters, shell status indicators (T118)
- **012**: Parallel builds (T410)

## UX Guide

Read `specs/ux-guide.md`: the UX bible for the shell and apps. Key rules:
1. **Toggle consistency**: Click to open, click same spot to close. Light dismiss. Escape.
2. **No layout shift**: Transient panels overlay, never push content. Buttons never move.
3. **Spatial memory**: Window positions, panel states, view preferences persist across reloads.
4. **Progressive disclosure**: Clean defaults, details one click away, settings two clicks away.
5. **Empty states are onboarding**: Icon + headline + description + CTA. Never a blank screen.
6. **Animation as communication**: 150-300ms, ease-out for enter, ease-in for exit.

## Shell Patterns

- **Never mutate state objects in reducers**:`reduceChat` and similar must create new objects via spread (`{ ...obj, content: obj.content + delta }`) instead of mutating in-place (`obj.content += delta`). Shallow array copies (`[...arr]`) share object references; mutating them causes React double-rendering bugs (streaming text duplication).

## Shell Icon System

App icons are generated via FAL AI (`fal-ai/z-image/turbo`) and stored as PNGs in `~/system/icons/{slug}.png`. The icon style is configurable in `~/system/desktop.json` (field `iconStyle`).

### Icon Loading Flow

1. `loadModules()` discovers apps from `/api/apps` (built-in) and `modules.json` (user modules)
2. `addApp()` sets an optimistic icon URL pointing to `/files/system/icons/{slug}.png`
3. `checkAndGenerateIcon()` does a HEAD request to verify the icon exists; if not, calls `POST /api/apps/{slug}/icon` to generate one
4. Generated icons are saved to disk and served with `Cache-Control: public, max-age=86400, immutable` + ETag

### Pitfalls (learned the hard way)

- **Never use `meta.icon` from module.json/manifest.json as an image URL.** Module authors put emojis, icon names (not paths), or garbage in this field. Always use the generated PNG at `/files/system/icons/{slug}.png`.
- **Never append `?t=Date.now()` for cache-busting on every load.** This defeats browser caching entirely. Use ETag-based versioning (`?v={etag}`) only when the file actually changes (e.g. after regeneration).
- **Reset `imgFailed` state when `iconUrl` prop changes.** If an `<img>` fails (404), React `useState(false)` for `imgFailed` gets set to `true` and stays `true` even when the parent passes a new valid `iconUrl`. Track the previous URL with `useRef` and reset `imgFailed` when it differs.
- **Cloudflare overrides `Cache-Control` headers.** `Cache-Control: no-cache` from the origin gets replaced by Cloudflare's default `max-age=14400`. Use `CDN-Cache-Control` header to control Cloudflare independently from the browser cache.
- **Changing `<img> src` triggers a re-download.** Even if the underlying image is identical, React re-renders with the new `src` and the browser fetches it again. Avoid updating icon URLs unnecessarily (e.g. don't switch from bare URL to `?v=etag` URL on every page load).
- **User container image must be rebuilt for shell changes.** The shell is a Next.js app built into the Docker image at build time. Gateway-only changes are included because the source is mounted, but shell `.tsx` changes require `docker build` + container upgrade. The `docker compose up --build` only rebuilds platform/proxy services, not user containers.
- **`docker build` needs `--build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...`** for Next.js to embed Clerk auth. Without it, the shell build fails or Clerk auth breaks.

### Bulk Icon Regeneration

After changing `iconStyle` in `desktop.json`, regenerate all icons:
```bash
curl -X POST https://{handle}.matrix-os.com/api/icons/regenerate-all
```

## Releases + Deployment

Tags follow SemVer with `v` prefix (`v0.1.0`, `v0.2.0`, ...). Pre-1.0: minor = features, patch = fixes.

```bash
bun run test                                          # verify
git tag -a v0.X.0 -m "Description"                    # tag
git push origin v0.X.0                                # push tag
git log $(git describe --tags --abbrev=0)..HEAD --oneline  # commits since last tag
```

VPS deployment: `docs/dev/vps-deployment.md` (platform, containers, Cloudflare, backups)
Release process: `docs/dev/releases.md`

## QMD (Markdown Search)

QMD is an on-device semantic search engine for markdown files. It indexes specs, docs, and notes for fast retrieval via BM25 keywords + vector embeddings + LLM reranking. A `qmd-researcher` subagent is available globally at `~/.claude/agents/qmd-researcher.md`.

### Setup (new dev or VPS)

```bash
npm install -g @tobilu/qmd

# If bun is installed, its BUN_INSTALL env var makes qmd pick bun as runtime.
# Bun crashes on sqlite-vec (no extension loading). Create a Node.js wrapper:
mkdir -p ~/.local/bin
QMD_JS="$(npm root -g)/@tobilu/qmd/dist/cli/qmd.js"
printf '#!/bin/sh\nexec node "%s" "$@"\n' "$QMD_JS" > ~/.local/bin/qmd
chmod +x ~/.local/bin/qmd
# Ensure ~/.local/bin is in PATH before ~/.bun/bin

# Index this project
qmd collection add /path/to/matrix-os --name matrix-os
qmd embed   # first run downloads ~2GB of models, uses Metal/CUDA GPU

# Add MCP server to ~/.claude/settings.json for Claude Code integration:
# "mcpServers": { "qmd": { "command": "qmd", "args": ["mcp"] } }
```

### Usage

```bash
qmd query "how does the kernel dispatch messages"  # hybrid (best recall)
qmd search "telegram adapter"                       # BM25 keyword (instant)
qmd get "qmd://matrix-os/specs/006-channels/spec.md"  # full doc
qmd status                                          # health check
```

## Development Rules

- **Specs and plans go in `specs/`** -- NEVER use `docs/plans/`. All feature specs, implementation plans, and task files live in `specs/{NNN}-{feature-name}/`. The `docs/` directory is for reference documentation only.
- Use Next.js/Vercel/React skills and best practices when working on frontend (shell or www)
- Next.js 16: `proxy.ts` replaces `middleware.ts`, Turbopack by default, React Compiler stable, `cacheComponents` replaces PPR
- TDD: write failing tests FIRST, then implement (Red -> Green -> Refactor)
- Spike before spec: test undocumented SDK behavior with throwaway code before committing
- Conventional Commits: all commit messages and PR titles must use a type prefix (`feat:`, `fix:`, `test:`, `chore:`, `ci:`, `docs:`, `refactor:`, `style:`, `perf:`, `build:`, `revert:`)
- Commit after completing each phase or major feature
- Tag releases after completing major milestones (see Releases section)
- No emojis in code or docs
- No co-authored-by lines in commits
- Minimal comments: code should be self-documenting
- No over-engineering: solve the current problem
- Keep kernel system prompt under 7K tokens
- Always use Drizzle ORM for database access: never raw SQL queries with better-sqlite3 directly
- **Documentation**: after completing a major feature, run `/update-docs` to audit and update all documentation (CLAUDE.md, docs/dev/, www/content/docs/, README.md). The docs site at matrix-os.com/docs (Fumadocs in `www/`) is the public-facing reference -- keep it in sync with the codebase

## Swarm / Multi-Agent Rules

- **NEVER use worktree isolation** for agents (`isolation: "worktree"` is BANNED). Worktrees lose uncommitted changes on cleanup. Always run agents directly on the repo.
- **Agents MUST commit their progress** as they go. Instruct every spawned agent to `git add` + `git commit` after completing each phase or major feature. Never rely on uncommitted changes surviving agent shutdown.
- **NEVER call TeamDelete**. Leave team files in place. Teams are cheap (just JSON files). Losing worktrees or agent state is expensive. Only clean up manually if explicitly asked by the user.
- Agents all work on **main** (or whichever current branch) in parallel. No feature branches for swarm agents -- keep it simple.
