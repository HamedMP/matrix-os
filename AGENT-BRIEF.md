# Matrix OS Agent Brief

This document is the single source of context for any AI agent working on Matrix OS. Read this FIRST before touching any code.

## What Is Matrix OS

Matrix OS is **Web 4** -- a unified AI operating system. The Claude Agent SDK is the kernel. Software is generated from natural language, persisted as files, self-heals, and is reachable through multiple channels (web desktop, Telegram, WhatsApp, Discord, Slack, Matrix protocol).

**Website**: matrix-os.com | **Repo**: github.com/HamedMP/matrix-os

## Current State

**v0.3.0 tagged. 479 tests passing across 44 test files.**

Completed: kernel, gateway, shell, self-healing, self-evolution, concurrent dispatch, SOUL + skills, Telegram channel, cron + heartbeat, onboarding + Mission Control + Cmd+K, single-user cloud deploy, multi-tenant platform (Clerk auth, orchestrator), observability, identity system, git sync, mobile responsive + PWA.

## Tech Stack

- **Language**: TypeScript 5.5+, strict mode, ES modules
- **Runtime**: Node.js 24+
- **AI**: Claude Agent SDK V1 `query()` with `resume` + Opus 4.6
- **Frontend**: Next.js 16, React 19
- **Backend**: Hono (HTTP/WebSocket gateway)
- **Database**: SQLite via Drizzle ORM (better-sqlite3, WAL mode)
- **Validation**: Zod 4 (`zod/v4` import)
- **Testing**: Vitest (TDD, 99-100% coverage target, `@vitest/coverage-v8`)
- **Package Manager**: pnpm (install), bun (run scripts) -- NEVER npm
- **Channels**: node-telegram-bot-api
- **Scheduling**: node-cron, native timers

## Project Structure

```
packages/kernel/     # AI kernel (Agent SDK, agents, IPC tools, hooks, SOUL, skills, memory)
packages/gateway/    # Hono HTTP/WebSocket gateway + channels + cron + heartbeat
packages/platform/   # Multi-tenant platform service (Clerk, orchestrator)
shell/               # Next.js 16 desktop shell (React 19)
www/                 # Landing page + dashboard + auth (Next.js, Clerk)
home/                # File system template (copied to ~/matrixos/ on first boot)
tests/               # Vitest test suites (mirrors packages/ structure)
specs/               # Architecture specs (one folder per phase)
docs/                # Reference documentation
bin/                 # CLI entry points
```

## Key Files You'll Touch

### Kernel (packages/kernel/src/)
- `ipc-server.ts` -- IPC MCP tools (currently 14 tools). **Multiple specs add tools here. Be additive only.**
- `prompt.ts` -- System prompt builder. Token budget: 7K max. `buildSystemPrompt()` assembles all sections.
- `spawn.ts` -- Kernel spawning (Agent SDK `query()` with `resume`).
- `hooks.ts` -- PreToolUse/PostToolUse hooks (protected files, git snapshots).
- `db.ts` -- SQLite schema (Drizzle ORM). Tasks table, messages table.
- `skills.ts` -- Skill loader. Reads `~/agents/skills/*.md`, parses frontmatter.
- `soul.ts` -- SOUL/identity/user/bootstrap loaders.
- `identity.ts` -- Handle system (`@user:matrix-os.com`).

### Gateway (packages/gateway/src/)
- `server.ts` -- Hono HTTP server + WebSocket endpoints (`/ws`, `/ws/terminal`). **Multiple specs add endpoints here.**
- `dispatcher.ts` -- Routes messages to kernel. Concurrent dispatch with maxConcurrency.
- `conversations.ts` -- ConversationStore (JSON files in `~/system/conversations/`).
- `main.ts` -- Gateway bootstrap (starts all services).
- `channels/` -- Channel adapters (Telegram done, others deferred).
- `cron/` -- Cron service + store.
- `heartbeat/` -- Heartbeat runner.
- `git-sync.ts` -- Git sync + auto-sync.

### Shell (shell/src/)
- `app/page.tsx` -- Main page (Desktop + InputBar + overlays).
- `components/Desktop.tsx` -- Desktop with dock, windows, Mission Control.
- `components/InputBar.tsx` -- Bottom-center input bar.
- `components/ChatPanel.tsx` -- Sidebar chat panel.
- `components/ResponseOverlay.tsx` -- Floating response card.
- `components/MissionControl.tsx` -- Kanban task board + cron.
- `components/CommandPalette.tsx` -- Cmd+K palette.
- `hooks/useChatState.ts` -- Chat state management.
- `hooks/useSocket.ts` -- WebSocket connection.
- `components/ui-blocks/` -- Rich content rendering (cards, options, status).

### www (www/src/app/)
- `page.tsx` -- Landing page (hero, features, Web4, CTA).
- `signup/` -- Clerk signup (currently centered, being redesigned).
- `login/` -- Clerk login.
- `dashboard/` -- User dashboard (instance status, provision).
- `admin/` -- Admin panel.

### Home Template (home/)
- `apps/` -- App files (HTML, served via /files/).
- `agents/skills/` -- Skill .md files (7 existing: summarize, weather, reminder, skill-creator, budget-helper, study-timer, setup-wizard).
- `agents/custom/` -- Agent prompts (builder, researcher, deployer, healer, evolver).
- `agents/knowledge/` -- Knowledge files for agents.
- `system/` -- Config, SOUL, identity, user, bootstrap, cron, modules, conversations, logs.
- `data/` -- App data directories.

## Non-Negotiable Rules

1. **TDD**: Write failing tests FIRST (`tests/` directory), then implement. Red -> Green -> Refactor.
2. **Everything Is a File**: All state persisted as files in `~/matrixos/`. No opaque runtime-only state.
3. **No emojis** in code or docs.
4. **No over-engineering**. Solve the current task, not hypothetical futures.
5. **Minimal comments**. Code should be self-documenting.
6. **pnpm install, bun run scripts**. NEVER npm.
7. **Zod 4**: Import from `zod/v4`, not `zod`.
8. **ES modules**: `"type": "module"` everywhere.
9. **TypeScript strict mode**.
10. **Token budget**: System prompt stays under 7K tokens. Use `estimateTokens()` in prompt.ts.

## Running

```bash
pnpm install                   # Install deps
bun run test                   # Unit tests (479 tests, ~10s)
bun run dev                    # Gateway (4000) + Shell (3000)
bun run dev:gateway            # Gateway only
bun run dev:shell              # Shell only
```

## Existing IPC Tools (in ipc-server.ts)

`list_tasks`, `create_task`, `claim_task`, `complete_task`, `fail_task`, `send_message`, `read_messages`, `read_state`, `load_skill`, `get_persona_suggestions`, `write_setup_plan`, `set_handle`, `sync_files`, `manage_cron`

**When adding tools**: just append to the `tools` array. Don't modify existing tools. Test new tools in the appropriate test file.

## Config Schema (home/system/config.json)

Current sections: `channels`, `heartbeat`, `activeHours`. New specs add: `approval`, `media`, `voice`, `memory`, `browser`. Each section is additive. Validate with Zod on load.

## Spec & Task Reference

Each spec lives in `specs/{number}-{name}/tasks.md`. Read your assigned spec's tasks.md for full task definitions including:
- User stories
- Test requirements (write FIRST)
- Implementation details
- Implications and cross-cutting concerns
- Checkpoint criteria

## Coordination Rules

1. **Don't modify files outside your spec scope** without checking with the lead.
2. **ipc-server.ts is shared**: multiple specs add tools. Be additive. Don't reorder existing tools.
3. **config.json is shared**: add new sections, don't modify existing ones.
4. **prompt.ts is shared**: if you add a section, respect the 7K token budget.
5. **server.ts is shared**: add new endpoints/routes, don't modify existing ones.
6. **Run `bun run test` before declaring done**. All 479+ tests must still pass.
7. **Commit after each completed task group** with descriptive message.

## Parallelization Groups

```
GROUP 1 (no deps, start immediately):
  014 Skills Library      T600-T614   home/agents/skills/ only
  020 Signup Redesign     T700-T709   www/ only
  022 Whitepaper          T730-T739   www/ only (content)
  023 Landing Page        T740-T752   www/ only
  018 CLI                 T680-T689   new bin/ + package

GROUP 2 (no deps between them, start with Group 1):
  015 Multi-Session       T620-T629   gateway + kernel + shell
  016 Memory / RAG        T640-T652   kernel (new module + DB + IPC)
  017 Image Gen           T660-T667   kernel (new module + IPC)

GROUP 3 (after Group 2):
  017 Voice               T668-T678   gateway + shell (after T662 usage tracker)
  021 Prebuilt Apps       T710-T725   home/ + kernel (after T661 image gen)
  015 Approval Gates      T630-T636   kernel + gateway + shell

GROUP 4 (after Group 3):
  019 Browser             T690-T699   new MCP package (after T674 voice)
  024 App Ecosystem       T760-T779   shell + kernel (after T720 prebuilt apps)
```
