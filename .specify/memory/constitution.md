# Matrix OS Constitution

## Core Principles

### I. Everything Is a File (NON-NEGOTIABLE)

Every piece of state, configuration, application, agent definition, and user data is a file on disk. The file system is the single source of truth. No opaque databases for core state, no hidden processes, no state that exists only in memory. If it matters, it's a file. If it's a file, you can inspect it, copy it, share it, version it, and back it up by copying a folder.

- Apps are files in `~/apps/` or codebases in `~/projects/`
- OS state is files in `~/system/`
- Agent definitions are markdown files in `~/agents/custom/`
- User data is JSON/SQLite in `~/data/`
- Sharing = sending a file. Backup = copying a folder.

### II. Agent Is the Kernel

The Claude Agent SDK is not a feature bolted onto the OS -- it IS the OS kernel. The agent has full machine control (file system, shell, processes, network). Every user interaction flows through the agent. The agent makes routing decisions, spawns sub-agents, and writes all artifacts to the file system. No separate "backend logic" -- the agent's reasoning IS the logic.

- Smart kernel: handles simple requests directly, forks sub-agents for heavy work
- Sub-agents are processes with isolated context windows
- Custom agents are markdown files the kernel discovers and spawns
- The agent pool is self-expanding (kernel creates new agents by writing files)

### III. Headless Core, Multi-Shell

The core (kernel + file system + agent) works without any UI. The web shell is one renderer that watches files and draws what it finds. Other shells (CLI, mobile, voice-only, API) read the same files. Never couple core logic to a specific renderer. The shell discovers apps -- it doesn't know what exists ahead of time.

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
- **AI Kernel**: Claude Agent SDK (V2 preview) with Opus 4.6
- **Frontend**: React + Nextjs
- **Database**: SQLite via Drizzle ORM (better-sqlite3 driver, WAL mode)
- **Web Server**: Hono (lightweight, WebSocket support)
- **Bundler**: Nextjs (frontend) + tsx (backend dev)
- **Validation**: Zod for schema validation
- No external dependencies when native Node.js APIs suffice
- Prefer CDN imports in generated HTML apps over npm-installed packages

## Development Workflow

- Verify every SDK assumption against actual docs before implementing
- Test against real Agent SDK behavior, not just docs (docs may be incomplete)
- Commit working increments -- each phase should produce a demoable state
- Pre-seed demo apps to avoid generation latency during recordings
- Keep the system prompt under 7K tokens (3% of context budget)

## Governance

This constitution supersedes all other development practices for Matrix OS. Amendments require updating this file with rationale. If a principle conflicts with implementation reality (e.g., SDK limitation), document the deviation in SDK-VERIFICATION.md and propose the simplest workaround.

**Version**: 1.0.0 | **Ratified**: 2026-02-11 | **Last Amended**: 2026-02-11
