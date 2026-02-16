# CLAUDE.md -- Matrix OS

## What This Is

Matrix OS is **Web 4** -- a unified AI operating system that combines OS, messaging, social media, AI assistants, and games into a single platform. The Claude Agent SDK serves as the kernel. The system generates software from natural language, persists everything as files, heals/evolves itself, and is reachable through multiple channels (web desktop, Telegram, WhatsApp, Discord, Slack, Matrix protocol).

**Website**: matrix-os.com

### The Web 4 Vision

- Runs on ALL your devices (laptop, phone, cloud) -- peer-to-peer git sync, no central server
- Federated identity via Matrix protocol: `@user:matrix-os.com` (human) / `@user_ai:matrix-os.com` (AI)
- AI-to-AI communication via Matrix custom events (modern email: AIs negotiate meetings, share data)
- Social layer: profiles, feeds, friends/family with privilege levels, aggregate existing platforms
- App marketplace: build, share, monetize apps (including multiplayer games with leaderboards)
- Security: "call center" model for external AI access (sandboxed context, not full account access)
- Full vision: `specs/web4-vision.md`

## Constitution (Source of Truth)

Read `.specify/memory/constitution.md` -- it defines the 6 non-negotiable principles and all tech constraints. Re-read it after compaction or on new sessions.

Key principles:
1. **Everything Is a File** -- file system is the single source of truth
2. **Agent Is the Kernel** -- Claude Agent SDK V1 `query()` with `resume` IS the kernel
3. **Headless Core, Multi-Shell** -- core works without UI, shell is one renderer
4. **Self-Healing and Self-Expanding** -- OS patches itself, creates new capabilities
5. **Simplicity Over Sophistication** -- simplest implementation that works
6. **TDD (NON-NEGOTIABLE)** -- tests first, 99-100% coverage target

## Architecture Specs

### Vision & North Star
- `specs/web4-vision.md` -- **Web 4 vision document** (the north star)
- `specs/matrixos-vision.md` -- original vision doc

### Active Specs (current work)
- `specs/004-concurrent/` -- Phase 7: Multiprocessing (T053-T056, T053 serial queue is pre-req for 006)
- `specs/005-soul-skills/` -- Phase 9: SOUL identity + skills (T100-T105, T100i-T100j audit fixes)
- `specs/006-channels/` -- Phase 10: Multi-channel messaging (T106-T119)
- `specs/007-proactive/` -- Phase 11: Cron + heartbeat (T120-T129)
- `specs/008-cloud/` -- Phase 12: Cloud deployment (T130-T136, T140-T159)
- `specs/009-platform/` -- Web 4 platform: identity, sync, mobile, marketplace, games (T200-T261)
- `specs/010-demo/` -- Phase 8: Demo polish + recording (T057-T064)
- `specs/011-new-computing/` -- New computing paradigms: Living Software, Socratic Computing, Intent-based (T300-T317)
- `specs/012-onboarding/` -- Personalized onboarding: role discovery, setup proposal, multi-agent provisioning (T400-T412)
- `specs/013-distro/` -- Linux distro + Docker deployment: Dockerfile, mkosi, systemd, cage kiosk (T500-T517)
- `specs/025-security/` -- Security hardening: content wrapping, SSRF, audit, sandbox, outbound queue (T800-T849)
- `specs/026-web-tools/` -- Web fetch + search: Cloudflare Markdown, Readability, Brave/Perplexity/Grok (T850-T869)
- `specs/027-expo-app/` -- Expo mobile app: chat, mission control, push notifications (T870-T899)
- `specs/028-browser/` -- Browser automation: Playwright MCP, role snapshots, composite tool (T900-T929)
- `specs/029-plugins/` -- Plugin system: manifest, API, hooks (void + modifying), security (T930-T969)
- `specs/030-settings/` -- Settings dashboard: agent, channels, skills, security, cron, plugins (T970-T999)

### Archive (Phases 1-6 complete)
- `specs/003-architecture/` -- original architecture spec, plan, tasks (reference only)
- `specs/003-architecture/SDK-VERIFICATION.md` -- SDK assumption verification
- `specs/003-architecture/KERNEL-AND-MEMORY.md` -- kernel and memory architecture detail

## Reference Docs

- `docs/agent-sdk/` -- Claude Agent SDK documentation
- `docs/claude-code-docs/` -- Claude Code documentation
- `docs/opus-4.6.md` -- Opus 4.6 features (adaptive thinking, effort, compaction, fast mode, 128K output, 1M context)
- `docs/context-window.md` -- context window management, 1M beta, compaction
- `docs/prompt-caching.md` -- prompt caching strategy (90% savings on repeated content)
- `docs/anthropic-ts-sdk-reference.md` -- Anthropic TypeScript SDK reference

## Tech Stack

- **Language**: TypeScript 5.5+, strict mode, ES modules
- **Runtime**: Node.js 22+
- **AI**: Claude Agent SDK V1 `query()` with `resume` + Opus 4.6
- **Frontend**: Next.js 16, React 19
- **Backend**: Hono (HTTP/WebSocket gateway + channel adapters)
- **Channels**: node-telegram-bot-api, @whiskeysockets/baileys, discord.js, @slack/bolt
- **Federation**: Matrix protocol (matrix-js-sdk) -- federated identity, AI-to-AI, E2E encryption
- **Database**: SQLite via Drizzle ORM (better-sqlite3, WAL mode)
- **Validation**: Zod 4 (`zod/v4` import)
- **Scheduling**: node-cron (cron expressions), native timers
- **Testing**: Vitest (TDD, 99-100% coverage, `@vitest/coverage-v8`)
- **Package Manager**: pnpm (install), bun (run scripts) -- NEVER npm

## Project Structure

```
packages/kernel/     # AI kernel (Agent SDK, agents, IPC, hooks, SOUL, skills)
packages/gateway/    # Hono HTTP/WebSocket gateway + channels + cron + heartbeat
packages/platform/   # Multi-tenant orchestrator (Hono :9000, Drizzle, dockerode)
packages/proxy/      # Shared API proxy (Hono :8080, usage tracking)
shell/               # Next.js 16 frontend (desktop shell -- one of many shells)
www/                 # matrix-os.com (Next.js on Vercel, Clerk auth, Inngest)
home/                # File system template (copied on first boot)
tests/               # Vitest test suites
spike/               # Throwaway SDK experiments
specs/               # Architecture specs
docs/                # Reference documentation
distro/              # Docker, cloudflared, systemd deployment configs
```

## SDK Decisions (Spike-Verified)

- V1 `query()` with `resume` -- V2 silently drops mcpServers, agents, systemPrompt
- `createSdkMcpServer()` + `tool()` for in-process MCP tools (Zod 4 schemas)
- `allowedTools` is auto-approve, NOT filter -- use `tools`/`disallowedTools` to restrict
- `AgentDefinition` v0.2.39+: includes `maxTurns`, `disallowedTools`, `mcpServers`, `skills` per agent
- `bypassPermissions` propagates to ALL subagents -- use PreToolUse hooks for access control
- Prompt caching: `cache_control: {type: "ephemeral"}` on system prompt + tools for 90% savings
- Integration tests use haiku to keep costs <$0.10 per run

## Running the Platform

### Prerequisites
- Node.js 22+
- pnpm (`corepack enable && corepack prepare pnpm@latest --activate`)
- `ANTHROPIC_API_KEY` env var set (for kernel AI features)

### Install
```bash
pnpm install
```

### Run Tests
```bash
bun run test              # Unit tests (97 tests, ~300ms)
bun run test:watch        # Watch mode
bun run test:integration  # Integration tests (needs API key, uses haiku)
bun run test:coverage     # Coverage report
```

### Start Development Servers
```bash
# All at once (gateway + shell):
bun run dev

# Or individually:
bun run dev:gateway   # Hono gateway on http://localhost:4000
bun run dev:shell     # Next.js shell on http://localhost:3000
```

The gateway boots the home directory at `~/matrixos/` on first run (copies from `home/` template, initializes git).

### Environment Variables
- `ANTHROPIC_API_KEY` -- required for kernel AI features
- `MATRIX_HOME` -- custom home directory path (default: `~/matrixos/`)
- `MATRIX_AUTH_TOKEN` -- bearer token for web shell auth (optional, for cloud deployment)
- `PORT` -- gateway port (default: 4000)
- `NEXT_PUBLIC_GATEWAY_WS` -- shell WebSocket URL (default: `ws://localhost:4000/ws`)
- `NEXT_PUBLIC_GATEWAY_URL` -- shell HTTP URL (default: `http://localhost:4000`)
- `GATEWAY_URL` -- Next.js proxy target (default: `http://localhost:4000`)
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

**Tests**: 479 passing (44 test files) | **Through Phase 009 P1 identity + Phase 009 P0 + Phase 008A/008B + Phase 007 + Phase 004 + Phase 012**

### Completed
- **Phase 1**: Monorepo, pnpm workspaces, Vitest, TypeScript strict
- **Phase 2**: SQLite/Drizzle schema, system prompt builder, agent frontmatter parser, first-boot
- **Phase 3**: Kernel (spawnKernel with V1 query+resume), IPC MCP server (8 tools incl load_skill), hooks (8 hooks incl gitSnapshotHook), gateway (Hono HTTP+WS, dispatcher with serial queue, file watcher), agent prompts (builder, researcher, deployer, healer, evolver -- in home/agents/custom/)
- **Phase 4**: Next.js 16 shell -- Desktop, ChatPanel, AppViewer, Dock, ActivityFeed, Terminal, ModuleGraph, OS bridge, InputBar, ResponseOverlay, window persistence, message queuing
- **Phase 5**: Self-healing -- heartbeat loop, healer sub-agent, backup/restore, activity.log, healing-strategies.md
- **Phase 6**: Self-evolution -- protected files hook, watchdog, evolver prompt
- **Phase 004**: Serial dispatch queue (T053), concurrent dispatch with maxConcurrency (T054), process registration in tasks table (T055), active process conflict avoidance in system prompt (T056)
- **Phase 005**: SOUL identity system (soul.md, identity.md, user.md, bootstrap.md), skills system (loadSkills, buildSkillsToc, load_skill IPC tool, 4 starter skills), agent prompt files in home/agents/custom/, createGitSnapshotHook, estimateTokens
- **Phase 006**: Multi-channel messaging -- ChannelAdapter interface, ChannelManager lifecycle, formatForChannel (Telegram/Discord/Slack/WhatsApp), Telegram adapter (polling, allowFrom), channel-aware dispatcher (DispatchContext), /api/channels/status, channel-routing knowledge file, channels config in config.json
- **Phase 007**: Cron + Heartbeat -- CronService (interval/once/cron schedules via node-cron), CronStore (atomic JSON persistence), manage_cron IPC tool, HeartbeatRunner (periodic kernel invocation with active hours), heartbeat prompt builder, wired into gateway startup/shutdown, cron.json hot-reload via file watcher, heartbeat config in config.json
- **Phase 008A**: Single-user cloud -- Dockerfile (multi-stage Alpine), docker-compose.yml, systemd service, auth middleware (MATRIX_AUTH_TOKEN bearer), setup-server.sh, /api/system/info endpoint
- **Phase 009 P0**: Observability + Safety -- interaction logger (JSONL daily rotation, prompt truncation, cost tracking), GET /api/logs query endpoint, safe mode agent (sonnet, restricted tools, diagnostic prompt), logs directory template
- **Phase 009 P1 Identity**: Handle registry (handle.json), loadHandle/saveIdentity/deriveAiHandle, profile.md + ai-profile.md templates, handle injection into system prompt, GET /api/profile + /api/ai-profile endpoints
- **Phase 012**: Onboarding -- persona engine (7 roles + keyword matching), setup plan (Zod schema), provisioner (batch dispatch + kanban task board), IPC tools, skill templates (study-timer, budget-helper), bootstrap.md flow, system prompt integration, Mission Control (kanban/grid toggle, cron section, add task, AppTile, TaskDetail, ui:cards/ui:options/ui:status blocks, zustand preferences), Cmd+K command palette (shadcn CommandDialog, Zustand command registry, global keyboard shortcuts)
- **Phase 009 P1 Sync+Mobile**: Git sync (auto-sync, sync_files IPC tool), mobile responsive shell, PWA manifest
- **Phase 008B**: Multi-tenant platform -- platform service (Hono :9000, Drizzle, dockerode orchestrator, lifecycle manager, social API), Clerk auth + Inngest provisioning in www/, admin dashboard, Cloudflare Tunnel + docker-compose.platform.yml

### In Progress
- **013A Docker** (T500-T506) -- Dockerfile + docker-compose.yml done. User working on additional distro scaffolding.

### Next Up (see specs/ for details)
- **011 New Computing** (T300-T317) -- Living Software, Socratic Computing, Intent-based Interfaces
- **013B Distro** (T510-T517) -- mkosi, systemd services, Plymouth, Raspberry Pi
- **010 Demo** (T057-T064) -- pre-seed apps, demo script, recording

### Deferred (lower priority within completed phases)
- **006**: WhatsApp (T113-T114), Discord (T115), Slack (T116) adapters, shell status indicators (T118)
- **012**: Parallel builds (T410)

## UX Guide

Read `specs/ux-guide.md` -- the UX bible for the shell and apps. Key rules:
1. **Toggle consistency**: Click to open, click same spot to close. Light dismiss. Escape.
2. **No layout shift**: Transient panels overlay, never push content. Buttons never move.
3. **Spatial memory**: Window positions, panel states, view preferences persist across reloads.
4. **Progressive disclosure**: Clean defaults, details one click away, settings two clicks away.
5. **Empty states are onboarding**: Icon + headline + description + CTA. Never a blank screen.
6. **Animation as communication**: 150-300ms, ease-out for enter, ease-in for exit.

## Shell Patterns

- **Never mutate state objects in reducers** -- `reduceChat` and similar must create new objects via spread (`{ ...obj, content: obj.content + delta }`) instead of mutating in-place (`obj.content += delta`). Shallow array copies (`[...arr]`) share object references; mutating them causes React double-rendering bugs (streaming text duplication).

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

## Development Rules

- Use Next.js/Vercel/React skills and best practices when working on frontend (shell or www)
- Next.js 16: `proxy.ts` replaces `middleware.ts`, Turbopack by default, React Compiler stable, `cacheComponents` replaces PPR
- TDD: write failing tests FIRST, then implement (Red -> Green -> Refactor)
- Spike before spec: test undocumented SDK behavior with throwaway code before committing
- Commit after completing each phase or major feature
- Tag releases after completing major milestones (see Releases section)
- No emojis in code or docs
- No co-authored-by lines in commits
- Minimal comments -- code should be self-documenting
- No over-engineering -- solve the current problem
- Keep kernel system prompt under 7K tokens
- Always use Drizzle ORM for database access -- never raw SQL queries with better-sqlite3 directly
