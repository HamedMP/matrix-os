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
- `specs/004-concurrent/` -- Phase 7: Multiprocessing (T054-T056)
- `specs/005-soul-skills/` -- Phase 9: SOUL identity + skills (T100-T105)
- `specs/006-channels/` -- Phase 10: Multi-channel messaging (T106-T119)
- `specs/007-proactive/` -- Phase 11: Cron + heartbeat (T120-T129)
- `specs/008-cloud/` -- Phase 12: Cloud deployment (T130-T136)
- `specs/009-platform/` -- Web 4 platform: identity, sync, mobile, marketplace, games (T200-T261)
- `specs/010-demo/` -- Phase 8: Demo polish + recording (T057-T064)

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
shell/               # Next.js 16 frontend (desktop shell -- one of many shells)
home/                # File system template (copied on first boot)
tests/               # Vitest test suites
spike/               # Throwaway SDK experiments
specs/               # Architecture specs
docs/                # Reference documentation
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
                  |-- /health       Health check
                  |
                  |-- ChannelManager  (starts/stops channel adapters)
                  |-- CronService     (scheduled tasks from ~/system/cron.json)
                  |-- HeartbeatRunner (periodic kernel invocation)
                  |
                  +---> Dispatcher ---> Kernel (Agent SDK)
```

## Current State (updated per commit)

**Tests**: 200 passing (16 test files) | **Phase 6 complete + shell hardening**

### Completed
- **Phase 1**: Monorepo, pnpm workspaces, Vitest, TypeScript strict
- **Phase 2**: SQLite/Drizzle schema, system prompt builder, agent frontmatter parser, first-boot
- **Phase 3**: Kernel (spawnKernel with V1 query+resume), IPC MCP server (7 tools), hooks (8 hooks), gateway (Hono HTTP+WS, dispatcher, file watcher), agent prompts (builder, researcher, deployer)
- **Phase 4**: Next.js 16 shell -- Desktop (window mgmt), ChatPanel, AppViewer (iframe), Dock, ActivityFeed, Terminal (xterm.js+node-pty), ModuleGraph (vis-network), useSocket/useFileWatcher/useTheme hooks, proxy.ts, module reverse proxy
- **Phase 4b**: Chat history persistence -- ConversationStore (JSON files in system/conversations/), useConversation hook, ChatPanel with conversation switcher and "New Chat" button, hydrateMessages helper
- **Phase 4c**: Interaction model -- OS bridge (window.MatrixOS), bottom-center InputBar, SuggestionChips, ThoughtCard, collapsible BottomPanel (Cmd+J), toggleable ChatPanel sidebar, useChatState hook, bridge data endpoint
- **Phase 4d**: Shell polish -- ResponseOverlay (draggable/resizable streaming response card above InputBar), macOS-style left dock with app icons and tooltips, traffic light window buttons (red=close, yellow=minimize, green=maximize), draggable/resizable app windows with iframe pointer-steal prevention, Desktop loads active modules from system/modules.json, hello-world demo module pre-seeded in home template
- **Phase 4e**: Shell hardening -- window state persistence (layout.json via GET/PUT /api/layout, restore positions on refresh, closed windows stay in dock), message queuing (type-ahead while kernel busy, auto-drain on result/error, queue count badge), iframe sandbox fix (allow-same-origin for external APIs), builder prompt serving instructions
- **Phase 5**: Self-healing -- heartbeat loop (30s health checks on modules with ports), healer sub-agent (sonnet, 2-attempt limit), backup/restore before/after healing, activity.log + WebSocket error notifications, healing-strategies.md knowledge file
- **Phase 6**: Self-evolution -- protected files PreToolUse hook (denies writes to constitution, kernel/gateway src, tests, config), watchdog (tracks evolver commits, git reset on crash), full evolver prompt (git snapshots, allowed/denied modification targets)

### Next Up (see specs/004-010 for details)
- **005 SOUL + Skills** (T100-T105) -- agent identity, personality, expandable capabilities
- **006 Channels** (T106-T119) -- Telegram, WhatsApp, Discord, Slack, Matrix protocol
- **007 Proactive** (T120-T129) -- cron scheduled tasks, heartbeat, proactive agent wakeup
- **008 Cloud** (T130-T136) -- Dockerfile, systemd, auth, setup script
- **009 Platform** (T200-T261) -- Web 4: identity handles, git sync, mobile, marketplace, games, AI social
- **004 Concurrent** (T054-T056) -- concurrent kernel dispatch
- **010 Demo** (T057-T064) -- pre-seed apps, demo script, recording

## Shell Patterns

- **Never mutate state objects in reducers** -- `reduceChat` and similar must create new objects via spread (`{ ...obj, content: obj.content + delta }`) instead of mutating in-place (`obj.content += delta`). Shallow array copies (`[...arr]`) share object references; mutating them causes React double-rendering bugs (streaming text duplication).

## Development Rules

- Next.js 16: `proxy.ts` replaces `middleware.ts`, Turbopack by default, React Compiler stable, `cacheComponents` replaces PPR
- TDD: write failing tests FIRST, then implement (Red -> Green -> Refactor)
- Spike before spec: test undocumented SDK behavior with throwaway code before committing
- Commit after completing each phase or major feature
- No emojis in code or docs
- No co-authored-by lines in commits
- Minimal comments -- code should be self-documenting
- No over-engineering -- solve the current problem
- Keep kernel system prompt under 7K tokens
