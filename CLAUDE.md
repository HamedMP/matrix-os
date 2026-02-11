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
