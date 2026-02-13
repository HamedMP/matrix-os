# Matrix OS Constitution

## Core Principles

### I. Everything Is a File (NON-NEGOTIABLE)

Every piece of state, configuration, application, agent definition, and user data is a file on disk. The file system is the single source of truth. No opaque databases for core state, no hidden processes, no state that exists only in memory. If it matters, it's a file. If it's a file, you can inspect it, copy it, share it, version it, and back it up by copying a folder.

- Apps are files in `~/apps/` or codebases in `~/projects/`
- OS state is files in `~/system/`
- Agent identity is `~/system/soul.md`
- Agent definitions are markdown files in `~/agents/custom/`
- Skills are markdown files in `~/agents/skills/`
- Channel config is in `~/system/config.json`
- Cron jobs are in `~/system/cron.json`
- User data is JSON/SQLite in `~/data/`
- Sharing = sending a file. Backup = copying a folder.

### II. Agent Is the Kernel

The Claude Agent SDK is not a feature bolted onto the OS -- it IS the OS kernel. The agent has full machine control (file system, shell, processes, network). Every user interaction flows through the agent. The agent makes routing decisions, spawns sub-agents, and writes all artifacts to the file system. No separate "backend logic" -- the agent's reasoning IS the logic.

- Smart kernel: handles simple requests directly, forks sub-agents for heavy work
- Sub-agents are processes with isolated context windows
- Custom agents are markdown files the kernel discovers and spawns
- The agent pool is self-expanding (kernel creates new agents by writing files)

### III. Headless Core, Multi-Shell

The core (kernel + file system + agent) works without any UI. The web shell is one renderer that watches files and draws what it finds. Messaging channels (Telegram, WhatsApp, Discord, Slack) are additional shells that route through the same kernel. Other shells (CLI, mobile, voice-only, API) read the same files. Never couple core logic to a specific renderer. The shell discovers apps -- it doesn't know what exists ahead of time.

- Web desktop: visual interaction (browser at localhost:3000 or cloud URL)
- Telegram/WhatsApp/Discord/Slack: conversational interaction (text messages)
- Heartbeat: proactive interaction (OS reaches out on schedule)
- All shells route through the same gateway -> dispatcher -> kernel pipeline

### IV. Self-Healing and Self-Expanding

The OS detects failures, diagnoses root causes, and patches itself. The OS creates new capabilities by writing new agent files, knowledge files, and tools. Safety nets are mandatory: git snapshots before mutations, backup before patching, rollback on test failure, protected files list, watchdog process.

### V. Simplicity Over Sophistication

Start with the simplest implementation that works. Single-process async concurrency before worker threads. File-based IPC before message queues. SQLite before Postgres. HTML apps before full-stack frameworks. Escalate complexity only when the simpler approach fails under real use.

- YAGNI: don't build infrastructure for hypothetical scale
- Hackathon scope: working demo > perfect architecture
- Every abstraction must justify its existence

## Technology Constraints

- **Language**: TypeScript, strict mode, ES modules
- **Runtime**: Node.js 22+
- **AI Kernel**: Claude Agent SDK V1 `query()` with `resume` (V2 drops critical options) + Opus 4.6
- **Frontend**: React + Nextjs
- **Database**: SQLite via Drizzle ORM (better-sqlite3 driver, WAL mode)
- **Web Server**: Hono (lightweight, WebSocket support, channel adapters)
- **Channels**: node-telegram-bot-api (Telegram), @whiskeysockets/baileys (WhatsApp), discord.js (Discord), @slack/bolt (Slack)
- **Scheduling**: node-cron (cron expressions), native timers (intervals, one-shot)
- **Bundler**: Nextjs (frontend) + tsx (backend dev)
- **Validation**: Zod 4 for schema validation
- **Testing**: Vitest for unit/integration tests, TDD workflow, 99-100% coverage target
- **Package Manager**: pnpm (install), bun (run scripts)
- **Context Window**: 200K standard, 1M beta (`betas: ["context-1m-2025-08-07"]`, tier 4+)
- **Prompt Caching**: `cache_control: {type: "ephemeral"}` on tools + system prompt for 90% input cost savings on subsequent turns
- **Compaction**: Server-side compaction API for long kernel sessions
- No external dependencies when native Node.js APIs suffice
- Prefer CDN imports in generated HTML apps over npm-installed packages

## Development Workflow

### VI. Test-Driven Development (NON-NEGOTIABLE)

The OS is complex and self-modifying. TDD is mandatory to prevent regressions as the system evolves.

- **Tests first**: Write failing tests before implementation. Red -> Green -> Refactor.
- **Vitest** for all kernel and gateway tests (unit + integration)
- **Spike before spec**: When SDK behavior is undocumented, write a spike test against the real SDK before committing to an approach (as done for V1 vs V2 decision)
- **Test categories**:
  - **Unit tests**: Pure functions (prompt assembly, schema validation, frontmatter parsing)
  - **Integration tests**: SDK interactions (MCP tool calls, agent spawning, multi-turn resume, hooks)
  - **Contract tests**: IPC tool inputs/outputs match expected schemas
- **Test isolation**: Integration tests use haiku model to keep costs under $0.10 per suite run
- **Coverage target**: 99-100% for kernel and gateway packages. Measure with `vitest --coverage`.
- **No implementation without a failing test**: If a test can't be written for it, question whether it's needed

### Other Workflow Rules

- Verify every SDK assumption against actual docs before implementing
- Test against real Agent SDK behavior, not just docs (docs may be incomplete)
- Commit working increments -- each phase should produce a demoable state
- Pre-seed demo apps to avoid generation latency during recordings
- Keep the system prompt under 7K tokens (3% of context budget)

## Governance

This constitution supersedes all other development practices for Matrix OS. Amendments require updating this file with rationale. If a principle conflicts with implementation reality (e.g., SDK limitation), document the deviation in SDK-VERIFICATION.md and propose the simplest workaround.

**Version**: 1.3.0 | **Ratified**: 2026-02-11 | **Last Amended**: 2026-02-12

### Amendment Log

- **1.1.0** (2026-02-11): Added TDD principle (VI). Changed AI Kernel from V2 to V1 `query()` with `resume` based on spike testing. Added Vitest, pnpm/bun to tech constraints.
- **1.2.0** (2026-02-11): Added prompt caching strategy (90% input cost savings), 1M context window beta, compaction API, 99-100% test coverage target.
- **1.3.0** (2026-02-12): Expanded vision to include personal AI assistant capabilities. Added: SOUL identity (`soul.md`), skills system (`agents/skills/`), multi-channel messaging (Telegram, WhatsApp, Discord, Slack), cron scheduling, proactive heartbeat, cloud deployment. Expanded Principle III with channel shells. Added channel/scheduling tech constraints. Inspired by OpenClaw/Moltbot and Nanobot (both MIT, open source). Matrix OS is now both a visual OS and a personal AI assistant.
