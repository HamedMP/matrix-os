# Tasks: Matrix OS

**Input**: Design documents from `specs/003-architecture/`
**Prerequisites**: plan.md, FINAL-SPEC.md, SDK-VERIFICATION.md
**Verified by**: Spec coverage agent, SDK verification agent, vision alignment agent (2026-02-11)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (US1-US6)
- Exact file paths included

## User Stories

- **US1** (P0): "I describe what I need and working software appears" -- Kernel + Builder
- **US2** (P0): "I interact with the OS through a browser desktop" -- Web Shell + Chat
- **US3** (P0): "When something breaks, the OS heals itself" -- Self-Healing
- **US4** (P1): "The OS can modify its own interface and behavior" -- Self-Evolution
- **US5** (P1): "Multiple requests run without blocking each other" -- Multiprocessing
- **US6** (P2): "I can speak to the OS and it responds" -- Voice Gateway

---

## Phase 1: Setup

**Purpose**: Project scaffolding, dependencies, monorepo structure

- [ ] T001 Initialize monorepo with TypeScript strict mode, ESM, Node 22+ -- root `package.json` with workspaces for `packages/kernel`, `packages/gateway`, `shell/`
- [ ] T002 [P] Install kernel dependencies: `@anthropic-ai/claude-agent-sdk`, `drizzle-orm`, `better-sqlite3`, `zod`, `chokidar` in `packages/kernel/`
- [ ] T003 [P] Install gateway dependencies: `hono`, `@hono/node-server` in `packages/gateway/`
- [ ] T004 [P] Create Next.js 16 app in `shell/` with `create-next-app` -- App Router, TypeScript strict
- [ ] T005 [P] Configure tsx for backend dev server (`packages/kernel/`, `packages/gateway/`)
- [ ] T006 Create directory structure per plan.md -- `packages/`, `shell/`, `home/`, `tests/`

---

## Phase 2: Foundation (Blocking Prerequisites)

**Purpose**: SQLite/Drizzle, file system template, system prompt assembly

- [ ] T007 [US1] Define Drizzle schema in `packages/kernel/src/schema.ts` -- tasks table, messages table with types and indexes (from SDK-VERIFICATION.md Section 7.2). Tasks table replaces `processes.json` as the source of truth for active processes.
- [ ] T008 [US1] Create SQLite database setup in `packages/kernel/src/db.ts` -- Drizzle ORM instance with better-sqlite3 driver, WAL mode, run migrations
- [ ] T009 [P] [US1] Create initial file system template in `home/` -- must include ALL files from FINAL-SPEC Section 6: `system/state.md`, `system/theme.json`, `system/layout.json`, `system/config.json`, `system/modules.json` (empty array), `system/session.json` (empty), `system/activity.log` (empty), `agents/system-prompt.md`, `agents/user-profile.md` (stub), `agents/heartbeat.md`, `agents/memory/long-term.md` (empty), `agents/custom/` (empty dir), `apps/`, `modules/`, `data/`, `projects/`, `tools/`, `sessions/`, `templates/`, `themes/`
- [ ] T010 [P] [US1] Write knowledge files: `home/agents/knowledge/app-generation.md`, `theme-system.md`, `module-standard.md`
- [ ] T011 [US1] Implement `buildSystemPrompt()` in `packages/kernel/src/prompt.ts` -- reads registers (system-prompt.md), L1 cache (state.md, modules.json, activity.log tail, knowledge TOC, agent TOC), user context (user-profile.md, memory/long-term.md). Must stay under 7K tokens. Note: kernel uses custom system prompt string (not `preset: "claude_code"`), sub-agents can optionally use preset.
- [ ] T012 [US1] Implement first-boot logic: copy `home/` to `~/matrixos/` (or configured path) if not exists, initialize git repo in the home directory
- [ ] T013 [P] [US1] Create markdown frontmatter parser for agent definition files -- parse YAML frontmatter + body from `~/agents/custom/*.md`. Note: only `description`, `prompt`, `tools`, `model` map to SDK `AgentDefinition`. Other fields (`inject`, `mcp`, `maxTurns`) are Matrix OS extensions handled by kernel code.

**Checkpoint**: `buildSystemPrompt()` returns a valid string. Drizzle migrations run, tables created. File system template copies on first boot with all directories.

---

## Phase 3: Kernel -- US1 "Describe and it builds"

**Goal**: User sends a message via terminal/API, kernel routes it, builder creates an app, files appear on disk.

### Core Kernel

- [ ] T014 [US1] Implement IPC MCP server in `packages/kernel/src/ipc.ts` -- `createSdkMcpServer` with 7 tools: `list_tasks`, `claim_task`, `complete_task`, `fail_task`, `send_message`, `read_messages`, `read_state` (backed by Drizzle queries). **SDK note**: verify V2 `session.send()` works with `mcpServers` option -- V1 required streaming input for MCP. Test early; if V2 fails with MCP, fall back to V1.
- [ ] T015 [US1] Define core agent configs in `packages/kernel/src/agents.ts` -- builder (opus), healer (sonnet), researcher (haiku), deployer (sonnet), evolver (opus). Each with `description`, `prompt`, `tools`, `model` (SDK `AgentDefinition` fields only), plus IPC tool subsets in `tools` array. Note: per-agent `maxTurns` is not part of `AgentDefinition` -- handle at session level.
- [ ] T016 [US1] Implement `loadCustomAgents()` in `packages/kernel/src/agents.ts` -- scan `~/agents/custom/*.md`, parse frontmatter, resolve `inject` field (read knowledge files from `~/agents/knowledge/`, prepend to `prompt` string), resolve `mcp` field to `mcpServers` config at spawn time. Return SDK-compatible `AgentDefinition` objects.
- [ ] T017 [US1] Implement `kernelOptions()` in `packages/kernel/src/index.ts` -- custom system prompt, `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`, agents, mcpServers, hooks config, allowedTools (including `mcp__matrix-os-ipc__*` wildcard)
- [ ] T018 [US1] Implement `spawnKernel()` in `packages/kernel/src/index.ts` -- V2 SDK `unstable_v2_createSession`/`unstable_v2_resumeSession`, `send()`/`stream()` loop, session persistence. **SDK risk**: V2 option passthrough (agents, hooks, mcpServers, permissionMode) is assumed but not fully documented. If V2 rejects these options, fall back to V1 `query()` with streaming input. Test this before building hooks.

### Hooks

- [ ] T019 [P] [US1] Implement `updateStateHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Write|Edit, updates modules.json and state via Drizzle. Return `{ hookSpecificOutput: { hookEventName: input.hook_event_name } }`.
- [ ] T020 [P] [US1] Implement `logActivityHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Bash, appends to activity.log
- [ ] T021 [P] [US1] Implement `persistSessionHook` in `packages/kernel/src/hooks.ts` -- Stop hook, saves session ID to `~/system/session.json`. Must handle multi-session storage (multiple concurrent kernels each have their own session ID).
- [ ] T022 [P] [US1] Implement `gitSnapshotHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Write|Edit, git commit before mutations
- [ ] T023 [P] [US1] Implement `onSubagentComplete` in `packages/kernel/src/hooks.ts` -- SubagentStop hook. **SDK note**: `SubagentStopHookInput` does NOT include the subagent's result text. Read task output from SQLite IPC (where subagent called `complete_task`), correlate via `agent_id` -> `assigned_to`. Updates state.
- [ ] T024 [P] [US2] Implement `notifyShellHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Write|Edit, pushes file change events to shell via WebSocket (enables live desktop updates when kernel writes files)
- [ ] T025 [P] [US1] Implement `safetyGuardHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Bash, validates commands against safety rules (prevent `rm -rf /`, protect core OS paths)

### Gateway

- [ ] T026 [US1] Implement Hono server in `packages/gateway/src/index.ts` -- HTTP + WebSocket, exposes `/api/message` endpoint
- [ ] T027 [US1] Implement dispatcher in `packages/gateway/src/dispatcher.ts` -- receives messages, calls `spawnKernel()`, streams responses back via WebSocket
- [ ] T028 [US2] Implement file watcher on gateway side in `packages/gateway/src/watcher.ts` -- chokidar watches `~/matrixos/`, emits WebSocket events for file changes (producer side for shell's `useFileWatcher`)

### Agent Prompts

- [ ] T029 [US1] Write builder agent system prompt -- instructions for generating HTML apps in `~/apps/`, structured modules in `~/modules/`, theme integration via CSS vars, manifest.json creation. Must include: how to update modules.json, how to call IPC tools (`complete_task` with structured output), how to create new custom agents when encountering unfamiliar domains.
- [ ] T030 [P] [US1] Write researcher agent system prompt -- instructions for gathering information, using WebSearch/WebFetch, returning findings via `send_message` IPC tool
- [ ] T031 [P] [US1] Write deployer agent system prompt -- instructions for deploying to hosting platforms, reading deployment knowledge, managing deployment configs

**Checkpoint**: Send "Build me an expense tracker" via REST API -> builder agent runs -> `~/apps/expense-tracker.html` appears on disk. Kernel streams progress. Shell receives file change WebSocket event.

---

## Phase 4: Web Shell -- US2 "Browser desktop"

**Goal**: Open browser, see desktop, chat with kernel, apps appear as windows.

### Shell Foundation (Next.js 16)

- [ ] T032 [US2] Implement `useFileWatcher` hook in `shell/hooks/useFileWatcher.ts` -- WebSocket connection to gateway (consumes events from T028), receives file change events
- [ ] T033 [US2] Implement `useTheme` hook in `shell/hooks/useTheme.ts` -- reads `theme.json` via WebSocket, sets CSS custom properties on `:root`
- [ ] T034 [US2] Implement shell layout in `shell/app/layout.tsx` and `shell/app/page.tsx` -- desktop canvas with dock, chat panel, app area

### Shell Components (Core)

- [ ] T035 [P] [US2] Implement `ChatPanel.tsx` in `shell/components/` -- client component, text input, send to kernel via WebSocket, stream response, show assistant messages
- [ ] T036 [P] [US2] Implement `AppViewer.tsx` in `shell/components/` -- client component, renders HTML apps from `~/apps/` as iframes, theme injection via CSS vars
- [ ] T037 [P] [US2] Implement `Desktop.tsx` in `shell/components/` -- client component, window management for app viewers, drag/resize, minimize/maximize
- [ ] T038 [P] [US2] Implement `Dock.tsx` in `shell/components/` -- client component, reads `layout.json`, shows app launchers, click to open
- [ ] T039 [P] [US2] Implement `ActivityFeed.tsx` in `shell/components/` -- client component, streams `activity.log` via WebSocket, shows real-time agent actions

### Shell Components (Demo-Critical) -- promoted from Phase 8

- [ ] T040 [P] [US2] Implement `Terminal.tsx` in `shell/components/` -- xterm.js + node-pty for in-browser terminal. Required for demo Act 2 (composition via CLI)
- [ ] T041 [P] [US2] Implement `ModuleGraph.tsx` in `shell/components/` -- vis-network visualization of modules and connections from `modules.json`. Required for demo Act 2 and Act 5

### Shell Integration

- [ ] T042 [US2] Wire file watcher to shell -- new file in `~/apps/` triggers new window, file change reloads iframe, theme change re-skins
- [ ] T043 [US2] Implement reverse proxy in gateway for module web servers -- route `localhost:PORT/modules/<name>/` to module's port via httpxy
- [ ] T044 [US2] Configure Next.js rewrites in `shell/next.config.ts` to proxy WebSocket/API requests to Hono gateway

**Checkpoint**: Open `localhost:3000`, see empty desktop with chat panel and terminal. Type "Build me a notes app" -> streaming progress in chat -> app window appears on desktop. Module graph updates. Theme changes propagate to all apps.

---

## Phase 5: Self-Healing -- US3 "OS heals itself"

**Goal**: Break an app intentionally, OS detects, diagnoses, patches, and restarts.

- [ ] T045 [US3] Write healer agent system prompt -- diagnosis workflow, patch patterns, rollback on test failure
- [ ] T046 [US3] Write healing knowledge file `home/agents/knowledge/healing-strategies.md`
- [ ] T047 [US3] Implement health check loop in `packages/kernel/src/heartbeat.ts` -- heartbeat kernel instance, pings web modules every 30s, checks `/health` endpoint
- [ ] T048 [US3] Implement module backup before heal -- `cp -r` source to `.backup/`, restore on failure
- [ ] T049 [US3] Wire health check failure to healer spawn -- collect error logs + source + manifest, spawn healer sub-agent, verify fix via health check

**Checkpoint**: Create an app. Corrupt its source (break a SQL query). Health check fails within 30s. Healer diagnoses, patches, restarts. App works again.

---

## Phase 6: Self-Evolution -- US4 "OS modifies itself"

**Goal**: User asks the OS to change its own interface. Evolver agent modifies OS source safely.

- [ ] T050 [US4] Write evolver agent system prompt -- safety constraints, git snapshot before changes, protected files awareness
- [ ] T051 [US4] Implement protected files enforcement via `PreToolUse` hook in `packages/kernel/src/hooks.ts` -- **SDK note**: `bypassPermissions` propagates to ALL subagents and cannot be overridden. Must use PreToolUse hook with matcher `"Write|Edit"` to check `tool_input.file_path` against protected list, returning `{ hookSpecificOutput: { permissionDecision: "deny" } }`. This is the only way to restrict the evolver.
- [ ] T052 [US4] Implement watchdog process -- monitors OS process, if crash after self-modification, revert last git commit, restart
- [ ] T053 [US4] Wire evolver: user says "Add dark mode toggle" -> kernel spawns evolver -> evolver modifies shell code -> git snapshot -> Next.js hot-reloads

**Checkpoint**: Ask "Add a dark mode toggle to the dashboard". Evolver modifies shell source. Toggle appears. Click it -- theme changes. Git log shows the snapshot.

---

## Phase 7: Multiprocessing -- US5 "Parallel requests"

**Goal**: Multiple user requests run concurrently without blocking.

- [ ] T054 [US5] Implement concurrent kernel dispatch in `packages/gateway/src/dispatcher.ts` -- `Promise.allSettled` for parallel `spawnKernel()` calls, no blocking
- [ ] T055 [US5] Implement process registration via Drizzle -- kernel instances register/deregister in tasks table with `touching` paths. This replaces `processes.json` as the source of truth (state.md and processes.json are generated from SQLite for the system prompt's L1 cache).
- [ ] T056 [US5] Add conflict avoidance -- kernel reads active processes before starting, avoids paths claimed by other kernels

**Checkpoint**: Send "Build me a CRM" and immediately "Make the theme darker". Both run in parallel. Theme changes while CRM builds. No conflicts.

---

## Phase 8: Polish and Demo

**Purpose**: Demo reliability, pre-seeding, optional voice, recording

- [ ] T057 [P] Pre-seed 2-3 demo apps (expense tracker, notes, dashboard) -- pre-built in `home/apps/` for fast demo generation
- [ ] T058 [P] Implement `CodeEditor.tsx` in `shell/components/` -- Monaco editor for viewing/editing any file
- [ ] T059 [P] Implement `FileBrowser.tsx` in `shell/components/` -- tree view of the file system
- [ ] T060 [US6] (STRETCH) Voice gateway -- Web Speech API for input, text-to-speech for output. Vision says voice-first, but for hackathon demo, chat proves the concept.
- [ ] T061 Validate dynamic agent creation -- test that kernel can write a new `~/agents/custom/*.md` file and spawn it within the same session. This validates the "OS creates new capabilities by writing files" vision promise.
- [ ] T062 Write demo script matching FINAL-SPEC.md Section 16 (3-minute narrative). Explicitly test cross-module data flow in Act 2 (expense-cli writes data that expense-web reads).
- [ ] T063 Create `git tag demo-safe` before recording for nuclear rollback
- [ ] T064 Record 3-minute demo video

---

## Dependencies and Execution Order

### Phase Dependencies

```
Phase 1 (Setup) ─────────────> Phase 2 (Foundation)
                                    |
                                    v
                               Phase 3 (Kernel / US1)
                                    |
                          ┌─────────┼─────────┐
                          v         v         v
                     Phase 4    Phase 5    Phase 7
                     (Shell)   (Healing)  (Multiproc)
                       US2       US3        US5
                          |         |
                          v         v
                     Phase 6 (Evolution / US4)
                          |
                          v
                     Phase 8 (Polish + Demo)
```

### Critical Path

Setup -> Foundation -> Kernel -> Shell -> Polish = minimum for demo

64 total tasks. T001-T064.

### Parallel Opportunities

- Phase 4 (Shell), Phase 5 (Healing), and Phase 7 (Multiprocessing) can run in parallel after Phase 3
- All [P] tasks within a phase can run in parallel
- Knowledge file writing (T010) can parallel with SQLite setup (T007)
- Shell components (T035-T041) are all parallelizable
- Hook implementations (T019-T025) are all parallelizable
- Agent prompts (T029-T031) can parallel with hook implementations

### MVP Path (US1 + US2 only)

1. Phase 1: Setup
2. Phase 2: Foundation
3. Phase 3: Kernel (US1) -- "describe and it builds" via API
4. Phase 4: Shell (US2) -- browser desktop with chat + terminal + module graph
5. Phase 8: Polish -- pre-seed, demo script, record

This gives a working demo: open browser -> chat -> apps appear -> terminal works -> module graph shows architecture.

---

## Verification Notes

Findings from the agent swarm verification (2026-02-11):

### Addressed in this revision
- Added `notifyShellHook` (T024) and `safetyGuardHook` (T025) -- were in spec but had no tasks
- Added researcher (T030) and deployer (T031) agent prompts -- were missing
- Added gateway-side file watcher (T028) -- shell had consumer but no producer
- Expanded T009 to include all files from FINAL-SPEC Section 6 (modules.json, session.json, activity.log, heartbeat.md, user-profile.md, memory/)
- Promoted Terminal (T040) and ModuleGraph (T041) from Phase 8 to Phase 4 -- demo Acts 2 and 5 depend on them
- Added SDK notes to T014, T017, T018, T023, T051 about known gotchas
- Added T061 to validate dynamic agent creation (vision promise not previously tested)
- Added T062 note about cross-module data flow validation
- Clarified in T055 that SQLite replaces processes.json as source of truth

### Accepted risks
- V2 SDK instability: fallback to V1 documented in SDK-VERIFICATION.md
- V2 option passthrough not fully documented: test early in Phase 3
- Voice is vision-first but implementation-last: acceptable for hackathon, demo script should not promise voice
- MCP inbound gateway: deferred (P2), not needed for demo
- Sharing workflow: architecturally enabled (apps are files), no explicit export/import UI
- Full heartbeat behavior (scheduled tasks, pattern observation): only health check pings are implemented, broader proactive behavior deferred

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to user story for traceability
- Each phase has a checkpoint to validate before proceeding
- SDK V2 is unstable -- if it breaks, fallback code path documented in SDK-VERIFICATION.md
- Pre-seeded apps are critical for demo pacing (30-90s generation is too slow for 3-min video)
- Git snapshots are cheap insurance -- commit early, commit often
- `bypassPermissions` propagates to all subagents -- use PreToolUse hooks for access control
