# Implementation Plan: Matrix OS

**Branch**: `003-architecture` | **Date**: 2026-02-11 | **Spec**: `specs/003-architecture/FINAL-SPEC.md`
**Input**: Architecture specification from `specs/003-architecture/`

## Summary

Matrix OS is a real-time, self-expanding operating system AND personal AI assistant where the Claude Agent SDK serves as the kernel. The system generates software from natural language, persists everything as files, heals/evolves itself, and is reachable through multiple channels (web desktop, Telegram, WhatsApp, Discord, Slack, etc.). It combines the vision of Anthropic's "Imagine with Claude" (real-time software generation), OpenClaw/Moltbot (multi-channel personal AI assistant with heartbeat, cron, skills, SOUL identity), and a traditional OS (file system, processes, self-healing). The web shell is one renderer; messaging channels are additional shells -- all routing through the same kernel. Implementation uses TypeScript (strict, ESM), Hono for the gateway, Next.js 16 for the web shell, SQLite via Drizzle ORM for IPC/state, and the V1 `query()` API with `resume` for all AI operations. TDD with Vitest for all kernel and gateway features.

**Vision**: Matrix OS runs on a server (cloud VM, home server, or laptop). The user interacts visually through the web desktop OR conversationally through Telegram/WhatsApp/Discord/Slack. The OS proactively reaches out via heartbeat and scheduled tasks. It is both the operating system for your digital life and your personal AI assistant -- always on, always reachable, always learning.

## Technical Context

**Language/Version**: TypeScript 5.5+, strict mode, ES modules
**Primary Dependencies**: `@anthropic-ai/claude-agent-sdk`, Hono, Next.js 16, React 19, Drizzle ORM, better-sqlite3, Zod 4, chokidar, xterm.js, Monaco Editor, node-telegram-bot-api (Telegram channel), @whiskeysockets/baileys (WhatsApp channel), discord.js (Discord channel), @slack/bolt (Slack channel), node-cron (scheduled tasks)
**Storage**: SQLite via Drizzle ORM (WAL mode) for IPC/tasks/messages, JSON files for config, markdown files for agent definitions
**Testing**: Vitest (TDD -- tests first), integration tests against live Agent SDK with haiku
**Target Platform**: Node.js 22+ on macOS/Linux (local-first, runs on laptop, home server, or cloud VM)
**Project Type**: Web application (backend server + frontend shell) + multi-channel AI assistant service
**Deployment**: Single process (gateway) serves web shell, channels, cron, heartbeat. Designed to run as a systemd service on a cloud VM or locally.
**Constraints**: V1 `query()` API (V2 drops critical options per spike testing); Opus 4.6 calls are $2-5 per complex build; 200K context (1M beta: `betas: ["context-1m-2025-08-07"]`, tier 4+, 2x input above 200K); 128K max output; adaptive thinking + effort levels; compaction API for long sessions; fast mode (2.5x, premium pricing) for demos; no prefill support on Opus 4.6; prompt caching (90% savings on repeated system prompt + tools via `cache_control: {type: "ephemeral"}`)
**Scale/Scope**: Single user, local machine or cloud VM, 3-minute demo video
**Reference Projects**: OpenClaw/Moltbot (v2026.2.9, MIT, channel architecture + heartbeat + cron + skills), Nanobot (v0.1.3, MIT, lightweight agent + channels + SOUL)

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Everything Is a File | PASS | All state, apps, agents, config are files on disk |
| II. Agent Is the Kernel | PASS | Claude Agent SDK V1 `query()` with `resume` is the kernel, smart routing, sub-agents as processes |
| III. Headless Core, Multi-Shell | PASS | Core is Hono server + Agent SDK; web shell + Telegram + WhatsApp + Discord + Slack are all shells |
| IV. Self-Healing/Expanding | PASS | Healer agent + evolver agent + git safety. Phases 5-6 |
| V. Simplicity | PASS | Single-process async, SQLite, HTML apps first |

## Project Structure

### Documentation

```text
specs/003-architecture/
  FINAL-SPEC.md              # Architecture specification (visual OS)
  PERSONAL-ASSISTANT-SPEC.md # Personal assistant spec (SOUL, channels, cron, heartbeat, cloud)
  SDK-VERIFICATION.md         # SDK assumption verification report
  KERNEL-AND-MEMORY.md        # Detailed kernel and memory architecture
  ANALYSIS-FEEDBACK.md        # Four-reviewer analysis
  SUBAGENTS-INSPIRATION.md    # Sub-agent patterns from Claude Code
  AGENT-TEAMS-INSPIRATION.md  # Agent teams patterns
  plan.md                     # This file
  tasks.md                    # Task breakdown
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
      soul.ts               # SOUL identity loader (reads ~/system/soul.md, injects into all prompts)
      skills.ts             # Skills loader (reads ~/agents/skills/*.md, makes available to kernel)
  gateway/                  # Backend: HTTP/WebSocket gateway (Hono)
    src/
      index.ts              # Hono server, WebSocket, REST API
      dispatcher.ts         # Message routing, concurrent kernel spawning
      watcher.ts            # chokidar file watcher, emits WebSocket events
      channels/             # Multi-channel messaging adapters
        types.ts            # ChannelAdapter interface, ChannelMessage, ChannelReply
        manager.ts          # ChannelManager: lifecycle, start/stop, routing
        telegram.ts         # Telegram Bot API adapter (node-telegram-bot-api)
        whatsapp.ts         # WhatsApp adapter (Baileys via bridge or direct)
        discord.ts          # Discord adapter (discord.js)
        slack.ts            # Slack adapter (@slack/bolt, Socket Mode)
      cron/                 # Scheduled tasks
        service.ts          # CronService: schedules, triggers, persistence
        store.ts            # JSON file store at ~/system/cron.json
      heartbeat/            # Proactive agent wakeup
        runner.ts           # HeartbeatRunner: periodic kernel invocation
        prompt.ts           # Heartbeat prompt builder (reads ~/agents/heartbeat.md)

shell/                      # Frontend: Next.js 16 app (web shell -- one of many shells)
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
    soul.md                 # SOUL identity: personality, values, communication style
    state.md
    theme.json
    layout.json
    config.json             # Includes channels config, cron config, heartbeat config
    session.json
    modules.json            # Empty array, populated as modules are built
    activity.log            # Empty, appended by logActivityHook
    cron.json               # Scheduled tasks (empty array)
    channels.json           # Channel runtime state (which channels connected)
  agents/
    system-prompt.md
    knowledge/
      app-generation.md
      healing-strategies.md
      theme-system.md
      module-standard.md
      channel-routing.md    # How to respond across channels (markdown vs plain text, etc.)
    user-profile.md
    heartbeat.md            # Proactive heartbeat prompt (checked every N minutes)
    memory/
      long-term.md          # Empty, grows with kernel observations
    custom/                 # User-created agent definitions (*.md)
    skills/                 # Skill definitions (*.md with frontmatter)
      summarize.md          # Summarize conversations, articles, etc.
      weather.md            # Weather lookup
      reminder.md           # Create reminders via cron
      skill-creator.md      # Meta-skill: create new skills
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
    prompt.test.ts            # buildSystemPrompt() unit tests
    agents.test.ts            # loadCustomAgents(), frontmatter parsing
    schema.test.ts            # Drizzle schema validation
    ipc.test.ts               # MCP tool contract tests
    hooks.test.ts             # Hook return value tests
    soul.test.ts              # SOUL identity loader tests
    skills.test.ts            # Skills loader tests
    kernel.integration.ts     # Live SDK: query + MCP + agents + resume
  gateway/
    dispatcher.test.ts        # Message routing
    watcher.test.ts           # File watcher events
    channels/
      types.test.ts           # ChannelAdapter interface tests
      manager.test.ts         # ChannelManager lifecycle tests
      telegram.test.ts        # Telegram adapter tests
      message-format.test.ts  # Cross-channel message formatting tests
    cron/
      service.test.ts         # CronService tests
      store.test.ts           # Cron store persistence tests
    heartbeat/
      runner.test.ts          # HeartbeatRunner tests
  shell/

spike/                        # Throwaway SDK experiments (not deployed)
  v2-sdk-spike.ts             # V1 vs V2 comparison (V2 drops options)
  multi-turn-spike.ts         # V1 resume pattern (proven)
  agents-spike.ts             # Sub-agent spawning (proven)
```

**Structure Decision**: Monorepo with `packages/kernel/` (backend AI logic), `packages/gateway/` (Hono WebSocket server + channel adapters + cron + heartbeat), and `shell/` (Next.js 16 frontend). The `home/` directory is a template copied to the user's home on first boot. Next.js handles the shell UI with server components for initial render and client components for real-time updates (WebSocket, file watching). Hono remains the WebSocket gateway since Next.js doesn't natively handle persistent WebSocket connections for kernel streaming. Channel adapters (Telegram, WhatsApp, Discord, Slack) live inside the gateway package as they are additional input/output shells that route through the same dispatcher. Cron and heartbeat also live in the gateway as they are periodic triggers that invoke the kernel. Inspired by OpenClaw/Moltbot's `ChannelPlugin` architecture and Nanobot's lightweight `MessageBus` pattern.

## Phases Overview

| Phase | Deliverable | Demo Milestone |
|-------|------------|----------------|
| 1. Setup | Project scaffolding, deps, Next.js + Hono | `bun run dev` starts |
| 2. Foundation | SQLite/Drizzle, file system template, system prompt assembly | Kernel boots, reads state |
| 3. Kernel | V1 SDK integration, core agents, IPC, hooks | "Build me X" works in terminal |
| 4. Web Shell | Next.js desktop, chat panel, terminal, module graph, file watching | Full browser-based desktop |
| 5. Self-Healing | Health checks, healer agent, backup/restore | Break app, watch it heal |
| 6. Self-Evolution | Evolver agent, git safety, protected files | OS modifies its own UI |
| 7. Multiprocessing | Concurrent dispatch, process registration, conflict avoidance | Parallel requests work |
| **9. SOUL + Skills** | **Agent identity (soul.md), skills system, prompt injection** | **Kernel has personality, can load skills** |
| **10. Channels** | **Telegram, WhatsApp, Discord, Slack adapters** | **Message OS from Telegram, get response** |
| **11. Cron + Heartbeat** | **Scheduled tasks, proactive agent wakeup** | **OS sends morning summary, runs reminders** |
| **12. Cloud Deploy** | **Dockerfile, systemd service, env config** | **Matrix OS runs on a cloud VM, reachable from anywhere** |
| 8. Polish | Demo pre-seeding, voice (stretch), recording | 3-minute demo recording |

**Phase 9-12 rationale**: These phases transform Matrix OS from a local visual OS into a full personal AI assistant reachable from anywhere. Inspired by OpenClaw/Moltbot (channel architecture, heartbeat, cron) and Nanobot (SOUL, skills, lightweight agent loop). Channels are the "Multi-Shell" principle realized -- Telegram/WhatsApp/Discord/Slack are shells, just like the web desktop. SOUL gives the OS personality. Skills give it expandable capabilities. Cron and heartbeat make it proactive rather than reactive. Cloud deployment makes it always-on.

## Complexity Tracking

No constitution violations anticipated. Spike testing confirmed V1 `query()` with `resume` as the kernel pattern (V2 drops mcpServers/agents/systemPrompt -- see SDK-VERIFICATION.md). Next.js 16 provides server components for initial shell render and React 19 for client-side real-time updates. TDD with Vitest -- tests written first for all kernel and gateway features. Channel adapters add complexity but each is isolated -- Telegram is simplest (HTTP polling), WhatsApp requires a Node.js bridge (Baileys), Discord/Slack use official SDKs with Socket Mode. Heartbeat and cron are gateway-level concerns that invoke the kernel on a timer.

~130 tasks across 12 phases (original 8 + 4 new). See tasks.md for full breakdown. Test coverage target: 99-100% for kernel and gateway packages.

### New user stories (Phase 9-12)

- **US7** (P0): "The OS knows who it is and has a personality" -- SOUL identity
- **US8** (P0): "I can message the OS from Telegram/WhatsApp/Discord/Slack" -- Multi-channel
- **US9** (P1): "The OS proactively reaches out with reminders and updates" -- Heartbeat + Cron
- **US10** (P1): "The OS runs on a cloud server, always reachable" -- Cloud deployment
