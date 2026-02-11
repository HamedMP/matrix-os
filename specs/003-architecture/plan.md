# Implementation Plan: Matrix OS

**Branch**: `003-architecture` | **Date**: 2026-02-11 | **Spec**: `specs/003-architecture/FINAL-SPEC.md`
**Input**: Architecture specification from `specs/003-architecture/`

## Summary

Matrix OS is a real-time, self-expanding operating system where the Claude Agent SDK (V2 preview) serves as the kernel. The system generates software from natural language, persists everything as files, and heals/evolves itself. Implementation uses TypeScript (strict, ESM), Hono for the gateway, Next.js 16 for the web shell, SQLite via Drizzle ORM for IPC/state, and the V2 Agent SDK for all AI operations.

## Technical Context

**Language/Version**: TypeScript 5.5+, strict mode, ES modules
**Primary Dependencies**: `@anthropic-ai/claude-agent-sdk`, Hono, Next.js 16, React 19, Drizzle ORM, better-sqlite3, Zod, chokidar, xterm.js, Monaco Editor
**Storage**: SQLite via Drizzle ORM (WAL mode) for IPC/tasks/messages, JSON files for config, markdown files for agent definitions
**Testing**: Vitest (unit/integration), manual testing against live Agent SDK
**Target Platform**: Node.js 22+ on macOS/Linux (local-first, runs on laptop or VM)
**Project Type**: Web application (backend server + frontend shell)
**Constraints**: Agent SDK V2 is unstable preview; Opus 4.6 calls are $2-5 per complex build and take 30-90s; 200K token context window
**Scale/Scope**: Single user, local machine, 3-minute demo video

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Everything Is a File | PASS | All state, apps, agents, config are files on disk |
| II. Agent Is the Kernel | PASS | Claude Agent SDK V2 is the kernel, smart routing, sub-agents as processes |
| III. Headless Core, Multi-Shell | PASS | Core is Hono server + Agent SDK; shell is Next.js app connected via WebSocket |
| IV. Self-Healing/Expanding | PASS | Healer agent + evolver agent + git safety. Phases 5-6 |
| V. Simplicity | PASS | Single-process async, SQLite, HTML apps first |

## Project Structure

### Documentation

```text
specs/003-architecture/
  FINAL-SPEC.md          # Architecture specification
  SDK-VERIFICATION.md     # SDK assumption verification report
  KERNEL-AND-MEMORY.md    # Detailed kernel and memory architecture
  ANALYSIS-FEEDBACK.md    # Four-reviewer analysis
  SUBAGENTS-INSPIRATION.md  # Sub-agent patterns from Claude Code
  AGENT-TEAMS-INSPIRATION.md  # Agent teams patterns
  plan.md                 # This file
  tasks.md                # Task breakdown
```

### Source Code

```text
packages/
  kernel/                   # Backend: AI kernel (runs as separate process)
    src/
      index.ts              # spawnKernel(), kernel session management
      agents.ts             # Core agent definitions + loadCustomAgents()
      prompt.ts             # buildSystemPrompt() assembly
      ipc.ts                # MCP server (task list + messaging via SQLite)
      hooks.ts              # PostToolUse, Stop, SubagentStop, PreToolUse hook implementations
      db.ts                 # Drizzle ORM instance, migrations
      schema.ts             # Drizzle schema (tasks, messages tables)
      heartbeat.ts          # Health check loop for self-healing
  gateway/                  # Backend: HTTP/WebSocket gateway (Hono)
    src/
      index.ts              # Hono server, WebSocket, REST API
      dispatcher.ts         # Message routing, concurrent kernel spawning
      watcher.ts            # chokidar file watcher, emits WebSocket events

shell/                      # Frontend: Next.js 16 app
  app/
    layout.tsx              # Root layout, theme provider
    page.tsx                # Desktop shell (main page)
    api/
      message/route.ts      # Proxies to gateway (if co-located) or direct WebSocket
  components/
    Desktop.tsx             # Window management, drag/resize
    ChatPanel.tsx           # User <-> kernel conversation
    AppViewer.tsx           # iframe renderer for ~/apps/
    ActivityFeed.tsx        # Streams activity.log
    ModuleGraph.tsx         # vis-network visualization
    Dock.tsx                # App launcher from layout.json
    Terminal.tsx            # xterm.js + node-pty
    CodeEditor.tsx          # Monaco editor
    FileBrowser.tsx         # File tree
  hooks/
    useFileWatcher.ts       # WebSocket file change events
    useTheme.ts             # Theme from theme.json -> CSS vars
  next.config.ts            # Next.js configuration

home/                       # Initial file system template (copied on first boot)
  system/
    state.md
    theme.json
    layout.json
    config.json
    session.json
    modules.json            # Empty array, populated as modules are built
    activity.log            # Empty, appended by logActivityHook
  agents/
    system-prompt.md
    knowledge/
      app-generation.md
      healing-strategies.md
      theme-system.md
      module-standard.md
    user-profile.md
    heartbeat.md
    memory/
      long-term.md          # Empty, grows with kernel observations
    custom/                 # User-created agent definitions (*.md)
  apps/
  modules/
  data/
  projects/
  tools/
  sessions/                 # Stored kernel session data
  templates/
  themes/

tests/
  kernel/
  gateway/
  shell/
```

**Structure Decision**: Monorepo with `packages/kernel/` (backend AI logic), `packages/gateway/` (Hono WebSocket server), and `shell/` (Next.js 16 frontend). The `home/` directory is a template copied to the user's home on first boot. Next.js handles the shell UI with server components for initial render and client components for real-time updates (WebSocket, file watching). Hono remains the WebSocket gateway since Next.js doesn't natively handle persistent WebSocket connections for kernel streaming.

## Phases Overview

| Phase | Deliverable | Demo Milestone |
|-------|------------|----------------|
| 1. Setup | Project scaffolding, deps, Next.js + Hono | `npm run dev` starts |
| 2. Foundation | SQLite/Drizzle, file system template, system prompt assembly | Kernel boots, reads state |
| 3. Kernel | V2 SDK integration, core agents, IPC, hooks | "Build me X" works in terminal |
| 4. Web Shell | Next.js desktop, chat panel, terminal, module graph, file watching | Full browser-based desktop |
| 5. Self-Healing | Health checks, healer agent, backup/restore | Break app, watch it heal |
| 6. Self-Evolution | Evolver agent, git safety, protected files | OS modifies its own UI |
| 7. Multiprocessing | Concurrent dispatch, process registration, conflict avoidance | Parallel requests work |
| 8. Polish | Demo pre-seeding, voice (stretch), recording | 3-minute demo recording |

## Complexity Tracking

No constitution violations anticipated. The V2 SDK's unstable status is the main risk -- if it breaks, fallback to V1 `query()` with generator pattern (documented in SDK-VERIFICATION.md Section 1.2). Next.js 16 provides server components for initial shell render and React 19 for client-side real-time updates.

64 tasks across 8 phases, verified by three-agent swarm (spec coverage, SDK verification, vision alignment). See tasks.md for full breakdown and verification notes.
