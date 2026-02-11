# CLAUDE.md -- Matrix OS

## What This Is

Matrix OS is a real-time, self-expanding operating system where the Claude Agent SDK serves as the kernel. The system generates software from natural language, persists everything as files, and heals/evolves itself.

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

- `specs/003-architecture/FINAL-SPEC.md` -- full architecture specification
- `specs/003-architecture/plan.md` -- implementation plan, project structure, phases
- `specs/003-architecture/tasks.md` -- task breakdown (T001-T064 across 8 phases)
- `specs/003-architecture/SDK-VERIFICATION.md` -- SDK assumption verification, IPC layer design, cost optimization
- `specs/003-architecture/KERNEL-AND-MEMORY.md` -- kernel and memory architecture detail
- `specs/003-architecture/SUBAGENTS-INSPIRATION.md` -- sub-agent patterns from Claude Code
- `specs/003-architecture/AGENT-TEAMS-INSPIRATION.md` -- agent teams patterns
- `specs/003-architecture/ANALYSIS-FEEDBACK.md` -- four-reviewer analysis

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
- **Backend**: Hono (HTTP/WebSocket gateway)
- **Database**: SQLite via Drizzle ORM (better-sqlite3, WAL mode)
- **Validation**: Zod 4 (`zod/v4` import)
- **Testing**: Vitest (TDD, 99-100% coverage, `@vitest/coverage-v8`)
- **Package Manager**: pnpm (install), bun (run scripts) -- NEVER npm

## Project Structure

```
packages/kernel/     # AI kernel (Agent SDK, agents, IPC, hooks)
packages/gateway/    # Hono HTTP/WebSocket gateway
shell/               # Next.js 16 frontend (desktop shell)
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
- `PORT` -- gateway port (default: 4000)
- `NEXT_PUBLIC_GATEWAY_WS` -- shell WebSocket URL (default: `ws://localhost:4000/ws`)
- `NEXT_PUBLIC_GATEWAY_URL` -- shell HTTP URL (default: `http://localhost:4000`)
- `GATEWAY_URL` -- Next.js proxy target (default: `http://localhost:4000`)

### Architecture
```
Browser (localhost:3000)
  |-- Next.js shell (desktop, chat, terminal, module graph)
  |-- proxy.ts rewrites /gateway/* and /modules/* to gateway
  |
Gateway (localhost:4000)
  |-- /ws           Main WebSocket (chat, file watcher events)
  |-- /ws/terminal  PTY WebSocket (xterm.js <-> node-pty)
  |-- /api/message  REST endpoint for kernel messages
  |-- /files/*      Serve home directory files
  |-- /modules/*    Reverse proxy to module ports (3100-3999)
  |-- /api/theme    Current theme JSON
  |-- /api/conversations  Conversation list metadata
  |-- /health       Health check
```

## Current State (updated per commit)

**Tests**: 110 passing (12 test files) | **Phase 4b complete**

### Completed
- **Phase 1**: Monorepo, pnpm workspaces, Vitest, TypeScript strict
- **Phase 2**: SQLite/Drizzle schema, system prompt builder, agent frontmatter parser, first-boot
- **Phase 3**: Kernel (spawnKernel with V1 query+resume), IPC MCP server (7 tools), hooks (8 hooks), gateway (Hono HTTP+WS, dispatcher, file watcher), agent prompts (builder, researcher, deployer)
- **Phase 4**: Next.js 16 shell -- Desktop (window mgmt), ChatPanel, AppViewer (iframe), Dock, ActivityFeed, Terminal (xterm.js+node-pty), ModuleGraph (vis-network), useSocket/useFileWatcher/useTheme hooks, proxy.ts, module reverse proxy
- **Phase 4b**: Chat history persistence -- ConversationStore (JSON files in system/conversations/), useConversation hook, ChatPanel with conversation switcher and "New Chat" button, hydrateMessages helper

### Next Up
- **Phase 5**: Self-healing (T045-T049) -- healer agent, health checks, auto-patch
- **Phase 6**: Self-evolution (T050-T053) -- evolver agent, protected files, watchdog
- **Phase 7**: Multiprocessing (T054-T056) -- concurrent kernel dispatch
- **Phase 8**: Polish + demo (T057-T064) -- pre-seed apps, demo script, recording

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
