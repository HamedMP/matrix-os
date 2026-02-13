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
- **US7** (P0): "The OS knows who it is and has a personality" -- SOUL Identity + Skills
- **US8** (P0): "I can message the OS from Telegram/WhatsApp/Discord/Slack" -- Multi-Channel
- **US9** (P1): "The OS proactively reaches out with reminders and updates" -- Heartbeat + Cron
- **US10** (P1): "The OS runs on a cloud server, always reachable" -- Cloud Deployment

---

## Phase 1: Setup

**Purpose**: Project scaffolding, dependencies, monorepo structure, TDD infrastructure

- [x] T001 Initialize monorepo with TypeScript strict mode, ESM, Node 22+ -- root `package.json` with pnpm workspaces for `packages/kernel`, `packages/gateway`, `shell/`
- [x] T002 [P] Install kernel dependencies: `@anthropic-ai/claude-agent-sdk`, `drizzle-orm`, `better-sqlite3`, `zod@4`, `chokidar` in `packages/kernel/`
- [x] T003 [P] Install gateway dependencies: `hono`, `@hono/node-server` in `packages/gateway/`
- [x] T004 [P] Create Next.js 16 app in `shell/` with `create-next-app` -- App Router, TypeScript strict
- [x] T005 [P] Configure tsx for backend dev server, bun for running scripts (`packages/kernel/`, `packages/gateway/`)
- [x] T006 Create directory structure per plan.md -- `packages/`, `shell/`, `home/`, `tests/`, `spike/`
- [x] T006b [P] Configure Vitest in root -- `vitest.config.ts` with workspaces, separate configs for unit tests (fast, no SDK) and integration tests (live SDK, haiku, tagged `@integration`). Add `test` and `test:integration` scripts. Enable `@vitest/coverage-v8` for coverage reporting, target 99-100% for kernel and gateway packages.

---

## Phase 2: Foundation (Blocking Prerequisites)

**Purpose**: SQLite/Drizzle, file system template, system prompt assembly. TDD: write tests first.

### Tests (write FIRST, must FAIL before implementation)

- [x] T007a [P] [US1] Write `tests/kernel/schema.test.ts` -- test Drizzle schema: tasks table CRUD, messages table CRUD, indexes exist, WAL mode enabled
- [x] T007b [P] [US1] Write `tests/kernel/prompt.test.ts` -- test `buildSystemPrompt()`: returns string, stays under 7K tokens, includes all L1 cache sections, handles missing files gracefully
- [x] T007c [P] [US1] Write `tests/kernel/agents.test.ts` -- test frontmatter parser: valid YAML extracted, body preserved, `inject` field resolves knowledge files, unknown fields ignored, SDK `AgentDefinition` shape returned

### Implementation

- [x] T007 [US1] Define Drizzle schema in `packages/kernel/src/schema.ts` -- tasks table, messages table with types and indexes (from SDK-VERIFICATION.md Section 7.2). Tasks table replaces `processes.json` as the source of truth for active processes.
- [x] T008 [US1] Create SQLite database setup in `packages/kernel/src/db.ts` -- Drizzle ORM instance with better-sqlite3 driver, WAL mode, run migrations
- [x] T009 [P] [US1] Create initial file system template in `home/` -- must include ALL files from FINAL-SPEC Section 6: `system/state.md`, `system/theme.json`, `system/layout.json`, `system/config.json`, `system/modules.json` (empty array), `system/session.json` (empty), `system/activity.log` (empty), `agents/system-prompt.md`, `agents/user-profile.md` (stub), `agents/heartbeat.md`, `agents/memory/long-term.md` (empty), `agents/custom/` (empty dir), `apps/`, `modules/`, `data/`, `projects/`, `tools/`, `sessions/`, `templates/`, `themes/`
- [x] T010 [P] [US1] Write knowledge files: `home/agents/knowledge/app-generation.md`, `theme-system.md`, `module-standard.md`
- [x] T011 [US1] Implement `buildSystemPrompt()` in `packages/kernel/src/prompt.ts` -- reads registers (system-prompt.md), L1 cache (state.md, modules.json, activity.log tail, knowledge TOC, agent TOC), user context (user-profile.md, memory/long-term.md). Must stay under 7K tokens. Note: kernel uses custom system prompt string (not `preset: "claude_code"`), sub-agents can optionally use preset.
- [x] T012 [US1] Implement first-boot logic: copy `home/` to `~/matrixos/` (or configured path) if not exists, initialize git repo in the home directory
- [x] T013 [P] [US1] Create markdown frontmatter parser for agent definition files -- parse YAML frontmatter + body from `~/agents/custom/*.md`. Note: `description`, `prompt`, `tools`, `model`, `maxTurns`, `disallowedTools`, `mcpServers` map to SDK `AgentDefinition` (v0.2.39+). `inject` and `mcp` are Matrix OS extensions handled by kernel code.

**Checkpoint**: All T007a-c tests pass green. `buildSystemPrompt()` returns a valid string under 7K tokens. Drizzle migrations run, tables created. File system template copies on first boot.

---

## Phase 3: Kernel -- US1 "Describe and it builds"

**Goal**: User sends a message via terminal/API, kernel routes it, builder creates an app, files appear on disk.

### Tests (write FIRST, must FAIL before implementation)

- [x] T013a [P] [US1] Write `tests/kernel/ipc.test.ts` -- contract tests for all 7 MCP tools: `list_tasks` returns array, `claim_task` is atomic (prevents double-claim), `complete_task` stores output, `fail_task` sets error, `send_message` inserts row, `read_messages` marks as read, `read_state` returns summary. Test against in-memory SQLite.
- [x] T013b [P] [US1] Write `tests/kernel/hooks.test.ts` -- test hook return shapes: `updateStateHook` returns `hookEventName`, `safetyGuardHook` denies dangerous commands, `gitSnapshotHook` is called on Write/Edit
- [x] T013c [US1] Write `tests/kernel/kernel.integration.ts` -- `@integration` tagged: test full `spawnKernel()` -> MCP tool call -> result. Uses haiku. Tests: single turn works, resume preserves context, agent spawning works, hooks fire. Cost budget: <$0.20 per run.

### Core Kernel

- [x] T014 [US1] Implement IPC MCP server in `packages/kernel/src/ipc.ts` -- `createSdkMcpServer` with 7 tools: `list_tasks`, `claim_task`, `complete_task`, `fail_task`, `send_message`, `read_messages`, `read_state` (backed by Drizzle queries). **Spike-verified**: V1 `query()` with MCP tools works (tested 2026-02-11).
- [x] T015 [US1] Define core agent configs in `packages/kernel/src/agents.ts` -- builder (opus, effort: "max"), healer (sonnet), researcher (haiku, effort: "low"), deployer (sonnet), evolver (opus, effort: "high"). Each with SDK `AgentDefinition` fields: `description`, `prompt`, `tools`, `model`, `maxTurns`, `disallowedTools`. IPC tool subsets in `tools` array.
- [x] T016 [US1] Implement `loadCustomAgents()` in `packages/kernel/src/agents.ts` -- scan `~/agents/custom/*.md`, parse frontmatter, resolve `inject` field (read knowledge files from `~/agents/knowledge/`, prepend to `prompt` string), resolve `mcp` field to `mcpServers` config at spawn time. Return SDK-compatible `AgentDefinition` objects.
- [x] T017 [US1] Implement `kernelOptions()` in `packages/kernel/src/options.ts` -- custom system prompt with `cache_control: {type: "ephemeral"}` for prompt caching (90% savings on turns 2+), `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`, agents, mcpServers, hooks config, allowedTools, `thinking: { type: "adaptive" }` for Opus 4.6 adaptive thinking, effort level per context.
- [x] T018 [US1] Implement `spawnKernel()` in `packages/kernel/src/kernel.ts` -- V1 `query()` with `resume` option for multi-turn. Stream output via `for await` yielding KernelEvent (init, text, tool_start, tool_end, result). Return session ID for next turn. **Spike-verified**.

### Hooks

- [x] T019 [P] [US1] Scaffold `updateStateHook` in `packages/kernel/src/hooks.ts` -- wired into runtime, returns valid hook response. Full file I/O deferred (see execution-checklist.md section 10).
- [x] T020 [P] [US1] Scaffold `logActivityHook` in `packages/kernel/src/hooks.ts` -- wired into runtime. Full activity.log append deferred.
- [x] T021 [P] [US1] Scaffold `persistSessionHook` in `packages/kernel/src/hooks.ts` -- wired into runtime. Full session persistence deferred.
- [x] T022 [P] [US1] Scaffold `gitSnapshotHook` in `packages/kernel/src/hooks.ts` -- wired into runtime. Full git commit logic deferred.
- [x] T023 [P] [US1] Scaffold `onSubagentComplete` in `packages/kernel/src/hooks.ts` -- wired into runtime. Full SQLite correlation deferred.
- [x] T024 [P] [US2] Scaffold `notifyShellHook` in `packages/kernel/src/hooks.ts` -- wired into runtime. Full WebSocket push deferred.
- [x] T025 [P] [US1] Implement `safetyGuardHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Bash, validates commands against safety rules (prevent `rm -rf /`, protect core OS paths). Fully implemented.
- [x] T025b [P] [US1] Scaffold `preCompactHook` in `packages/kernel/src/hooks.ts` -- wired into runtime. Full state snapshot deferred.

### Gateway

- [x] T026 [US1] Implement Hono server in `packages/gateway/src/server.ts` -- HTTP + WebSocket, exposes `/api/message`, `/ws`, `/files/*`, `/api/bridge/data`, `/api/conversations`, `/api/layout`, `/api/theme`, `/health`
- [x] T027 [US1] Implement dispatcher in `packages/gateway/src/dispatcher.ts` -- receives messages, calls `spawnKernel()`, streams responses back via onEvent callback
- [x] T028 [US2] Implement file watcher on gateway side in `packages/gateway/src/watcher.ts` -- chokidar watches `~/matrixos/`, emits WebSocket events for file changes (producer side for shell's `useFileWatcher`)

### Agent Prompts

- [ ] T029 [US1] Write builder agent system prompt -- **Moved to 005-soul-skills as T100d.** Routing rules exist in system-prompt.md but no dedicated `home/agents/custom/builder.md` prompt file.
- [ ] T030 [P] [US1] Write researcher agent system prompt -- **Moved to 005-soul-skills as T100e.** No dedicated prompt file.
- [ ] T031 [P] [US1] Write deployer agent system prompt -- **Moved to 005-soul-skills as T100f.** No dedicated prompt file.

**Checkpoint**: Send "Build me an expense tracker" via REST API -> builder agent runs -> `~/apps/expense-tracker.html` appears on disk. Kernel streams progress. Shell receives file change WebSocket event.

---

## Phase 4: Web Shell -- US2 "Browser desktop"

**Goal**: Open browser, see desktop, chat with kernel, apps appear as windows.

### Shell Foundation (Next.js 16)

- [x] T032 [US2] Implement `useFileWatcher` hook in `shell/src/hooks/useFileWatcher.ts` -- WebSocket connection to gateway (consumes events from T028), receives file change events
- [x] T033 [US2] Implement `useTheme` hook in `shell/src/hooks/useTheme.ts` -- reads `theme.json` via file watcher, sets CSS custom properties on `:root`
- [x] T034 [US2] Implement shell layout in `shell/src/app/layout.tsx` and `shell/src/app/page.tsx` -- desktop canvas with dock, chat panel, app area

### Shell Components (Core)

- [x] T035 [P] [US2] Implement `ChatPanel.tsx` in `shell/src/components/` -- client component, text input, send to kernel via WebSocket, stream response, show assistant messages
- [x] T036 [P] [US2] Implement `AppViewer.tsx` in `shell/src/components/` -- client component, renders HTML apps from `~/apps/` as iframes, theme injection via CSS vars, bridge injection
- [x] T037 [P] [US2] Implement `Desktop.tsx` in `shell/src/components/` -- client component, window management for app viewers, drag/resize, minimize/maximize
- [x] T038 [P] [US2] Implement `Dock.tsx` in `shell/src/components/` -- client component, reads layout.json, shows app launchers, click to open/restore, active indicator
- [x] T039 [P] [US2] Implement `ActivityFeed.tsx` in `shell/src/components/` -- client component, streams `activity.log` via WebSocket, shows real-time agent actions

### Shell Components (Demo-Critical) -- promoted from Phase 8

- [x] T040 [P] [US2] Implement `Terminal.tsx` in `shell/src/components/` -- xterm.js + node-pty for in-browser terminal
- [x] T041 [P] [US2] Implement `ModuleGraph.tsx` in `shell/src/components/` -- vis-network visualization of modules and connections from `modules.json`

### Shell Integration

- [x] T042 [US2] Wire file watcher to shell -- new file in `~/apps/` triggers new window, file change reloads iframe, theme change re-skins
- [ ] T043 [US2] Implement reverse proxy in gateway for module web servers -- **Moved to 010-demo as T057b.** Partially implemented (gateway serves static files from modules/ but no port-based reverse proxy).
- [x] T044 [US2] Configure Next.js proxy in `shell/src/proxy.ts` to rewrite WebSocket/API requests to Hono gateway

**Checkpoint**: Open `localhost:3000`, see empty desktop with chat panel and terminal. Type "Build me a notes app" -> streaming progress in chat -> app window appears on desktop. Module graph updates. Theme changes propagate to all apps.

---

## Phase 4b: Chat History Persistence -- US2 "Conversations survive refresh"

**Goal**: Chat messages persist as JSON files in `~/matrixos/system/conversations/`. Page refresh reloads conversation. Multiple conversations switchable via dropdown. Follows "Everything Is a File" principle -- no new WebSocket message types needed.

### Tests (TDD)

- [x] T065 [US2] Write `tests/gateway/conversations.test.ts` -- ConversationStore: begin, addUserMessage, appendAssistantText, finalize, list, get, full flow (survives restart), multiple independent conversations (13 tests)

### Implementation

- [x] T066 [US2] Implement `createConversationStore()` in `packages/gateway/src/conversations.ts` -- pure utility: `begin`, `addUserMessage`, `appendAssistantText` (memory buffer), `finalize` (flush to disk), `list`, `get`. Assistant text buffered in memory during streaming, written once on finalize to prevent file watcher flooding.
- [x] T067 [P] [US2] Create `home/system/conversations/.gitkeep` -- empty dir in home template so `ensureHome()` creates it on first boot
- [x] T068 [US2] Wire conversations into `packages/gateway/src/server.ts` -- instantiate store, track `kernel:init` (begin + addUserMessage), `kernel:text` (appendAssistantText), `kernel:result` (finalize). Add `GET /api/conversations` endpoint.
- [x] T069 [P] [US2] Add `hydrateMessages()` to `shell/src/lib/chat.ts` -- converts persisted messages to `ChatMessage[]`
- [x] T070 [US2] Create `useConversation` hook in `shell/src/hooks/useConversation.ts` -- follows `useTheme` pattern: fetch on mount, re-fetch on `system/conversations/` file changes via `useFileWatcherPattern`
- [x] T071 [US2] Integrate into `ChatPanel.tsx` -- load latest conversation on mount, hydrate into state, add conversation switcher (Radix Select, visible when >1 conversation), "New Chat" button

**Checkpoint**: Send a message, refresh the page, conversation reloads. Send messages in two sessions, switch between them via dropdown. Conversation files appear at `~/matrixos/system/conversations/*.json` and are human-readable.

---

## Phase 4c: Interaction Model -- US2 "Click-to-generate, Imagine-style UX"

**Goal**: Bridge the gap between static iframe apps and Imagine's "click-to-generate" interaction model. Settle the interaction architecture before Phases 5-7 so self-healing and self-evolution work with interactive apps. Restructure shell layout for progressive disclosure.

**Spec**: `specs/003-architecture/phase-4c-interaction-model.md`

### OS Bridge

- [x] T072 [US2] Implement `shell/src/lib/os-bridge.ts` -- defines `window.MatrixOS` API (`generate`, `navigate`, `readData`, `writeData`, `app`), `postMessage` protocol between iframe and shell, `injectBridge(iframe, appName)` function, `handleBridgeMessage(event, sendToKernel)` handler. Bridge prefixes app context to kernel prompts: `"[App: {name}] {message}"`
- [x] T073 [US2] Write tests for OS bridge -- message serialization, context prefixing, data scope validation (app can only access `~/data/{appName}/`), unknown message types ignored
- [x] T074 [US2] Modify `AppViewer.tsx` -- inject bridge into iframe on load via `injectBridge()`, listen for `postMessage` events, route `os:generate` and `os:navigate` to kernel via existing WebSocket `send()`. Route `os:read-data` and `os:write-data` to new data endpoint.
- [x] T075 [US2] Add `POST /api/bridge/data` endpoint in `packages/gateway/src/server.ts` -- reads/writes JSON files in `~/data/{appName}/`. Scoped: rejects paths outside app namespace. Supports `{ action: "read"|"write", app: string, key: string, value?: string }`.

### Layout Restructure

- [x] T076 [P] [US2] Implement `InputBar.tsx` in `shell/src/components/` -- bottom-center text input bar, suggestion chips slot above, mic button placeholder (disabled), submit button. Uses existing `useSocket` `send()`. Replaces ChatPanel's input form as the primary interaction point.
- [x] T077 [P] [US2] Implement `SuggestionChips.tsx` in `shell/src/components/` -- renders contextual prompt chips. Empty desktop: "Build me a notes app", "Create an expense tracker", "Show what you can do". App open: "Add dark mode", "Make it faster". After error: "Fix this". Clicking submits as message.
- [x] T078 [P] [US2] Implement `ThoughtCard.tsx` in `shell/src/components/` -- floating top-right card showing agent activity. Shows tool name and spinner during `kernel:tool_start`, fades on `kernel:tool_end`/`kernel:result`. Subscribes to existing WebSocket events via `useSocket`.
- [x] T079 [US2] Implement `BottomPanel.tsx` in `shell/src/components/` -- collapsible panel containing Terminal, ModuleGraph, ActivityFeed as tabs. Hidden by default. Toggle via `Cmd+J`/`Ctrl+J`. Preference stored in `localStorage`.

### Integration

- [x] T080 [US2] Restructure `page.tsx` layout -- Desktop canvas fills screen, InputBar fixed at bottom-center, BottomPanel collapsible at bottom, ChatPanel becomes toggleable sidebar (history only, no input). ThoughtCard floats top-right over desktop.
- [x] T081 [US2] Modify `ChatPanel.tsx` -- remove input form (moved to InputBar), add collapse/expand toggle, show only message history and conversation switcher. Collapsed state shows a small toggle button at screen edge.

**Checkpoint**: Open `localhost:3000`, see clean canvas with bottom-center input bar and suggestion chips. Type "Build me a notes app" -> thought card shows agent working -> app window appears. Click inside the app -> bridge routes interaction back to kernel -> app updates. Press `Cmd+J` -> terminal/graph/feed panel slides up. Chat sidebar toggles independently.

---

## Phase 4d: Shell Polish -- US2 "Desktop feels like an OS"

**Goal**: Make the desktop feel native -- draggable/resizable windows, macOS-style dock, streaming response overlay, module auto-loading.

- [x] T082 [US2] `ResponseOverlay.tsx` -- streaming response card above InputBar, shows assistant response when sidebar is closed, dismissable via X, auto-reappears on next message
- [x] T083 [US2] Make ResponseOverlay draggable (header) and resizable (corner handle) with pointer capture, fixed positioning
- [x] T084 [US2] Desktop loads active modules from `system/modules.json` on mount and on file watcher changes, opens windows via `module.json` entry point
- [x] T085 [US2] Draggable/resizable app windows -- pointer-event drag on header, resize handle on bottom-right, transparent overlay prevents iframe pointer steal during interaction
- [x] T086 [US2] macOS-style left dock -- vertical sidebar with app initial icons, Radix tooltips on hover, active indicator dot, click to open/restore
- [x] T087 [US2] Traffic light window buttons -- red (x) close, yellow (-) minimize, green maximize placeholder, symbols appear on group hover
- [x] T088 [US2] Fix Desktop centering (add flex container to parent) and remove `bg-background` so body wave pattern shows through
- [x] T089 [US2] Pre-seed hello-world demo module in `home/modules/hello-world/` with `module.json` and `index.html`
- [x] T090 [US2] Fix `appNameFromPath` in AppViewer to handle `modules/` paths

**Checkpoint**: Refresh localhost:3000, hello-world opens in a draggable/resizable window with traffic light buttons. Left dock shows app icon. Close -> dock stays -> click dock icon -> window re-opens. Send a message -> streaming response overlay appears above input bar, draggable.

---

## Phase 5: Self-Healing -- US3 "OS heals itself"

**Goal**: Break an app intentionally, OS detects, diagnoses, patches, and restarts.

- [ ] T045 [US3] Write healer agent system prompt -- **Moved to 005-soul-skills as T100g.** Dispatch logic works (gateway spawns healer) but no dedicated `home/agents/custom/healer.md` prompt file.
- [x] T046 [US3] Write healing knowledge file `home/agents/knowledge/healing-strategies.md` -- 98 lines of healing patterns
- [x] T047 [US3] Implement health check loop in `packages/kernel/src/heartbeat.ts` -- createHeartbeat() with 30s intervals, /health endpoint checks, loadHealthCheckTargets from modules.json
- [x] T048 [US3] Implement module backup before heal -- `backupModule()` copies to .backup/, `restoreModule()` restores on failure
- [x] T049 [US3] Wire health check failure to healer spawn -- onHealthFailure callback in gateway dispatches heal prompt, logs to activity.log

**Checkpoint**: Create an app. Corrupt its source (break a SQL query). Health check fails within 30s. Healer diagnoses, patches, restarts. App works again.

---

## Phase 6: Self-Evolution -- US4 "OS modifies itself"

**Goal**: User asks the OS to change its own interface. Evolver agent modifies OS source safely.

- [ ] T050 [US4] Write evolver agent system prompt -- **Moved to 005-soul-skills as T100h.** Dispatch logic works but no dedicated `home/agents/custom/evolver.md` prompt file.
- [x] T051 [US4] Implement protected files enforcement via `createProtectedFilesHook()` in `packages/kernel/src/evolution.ts` -- checks file paths against PROTECTED_FILE_PATTERNS, returns `permissionDecision: "deny"` for Write/Edit on protected paths
- [x] T052 [US4] Implement watchdog process in `packages/kernel/src/evolution.ts` -- createWatchdog() monitors evolution, markEvolution/revertLastCommit within time window
- [x] T053 [US4] Wire evolver -- gateway dispatches evolver via dispatcher, protected files hook blocks core paths, watchdog tracks commits

**Checkpoint**: Ask "Add a dark mode toggle to the dashboard". Evolver modifies shell source. Toggle appears. Click it -- theme changes. Git log shows the snapshot.

---

## Phase 7: Multiprocessing -- US5 "Parallel requests"

**Moved to `specs/004-concurrent/tasks.md`** (T054-T056). Not started.

---

## Phase 8: Polish and Demo

**Moved to `specs/010-demo/tasks.md`** (T057-T064). Not started.

---

## Phase 9: SOUL + Skills -- US7 "OS has personality and expandable capabilities"

**Moved to `specs/005-soul-skills/tasks.md`** (T100-T105). Not started.

---

## Phase 10: Channels -- US8 "Message the OS from anywhere"

**Moved to `specs/006-channels/tasks.md`** (T106-T119). Not started.

---

## Phase 11: Cron + Heartbeat -- US9 "OS is proactive"

**Moved to `specs/007-proactive/tasks.md`** (T120-T129). Not started.

---

## Phase 12: Cloud Deployment -- US10 "Always on, always reachable"

**Moved to `specs/008-cloud/tasks.md`** (T130-T136). Not started.

---

## Summary

**Phases 1-6**: Complete (102 tasks done, 207 tests passing). Remaining forward work tracked in specs/004-010.

**Moved tasks**: Agent prompts (T029/T030/T031/T045/T050) moved to 005-soul-skills. Module reverse proxy (T043) moved to 010-demo. Phase 7-12 content moved to dedicated spec directories (004-008).

**Execution order**: See `specs/execution-checklist.md` for consolidated plan.

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

### Spike findings (2026-02-11)
- V1 `query()` with `resume` is the kernel pattern -- V2 silently drops mcpServers/agents/systemPrompt
- V1 MCP tools: PASS (createSdkMcpServer, in-process, Zod 4 schemas)
- V1 multi-turn with resume: PASS (3 turns, same session, $0.05 haiku)
- V1 agents: PASS (kernel routes to builder sub-agent, sub-agent uses MCP tools)
- AgentDefinition v0.2.39 now includes: maxTurns, disallowedTools, mcpServers, skills per agent
- `allowedTools` is auto-approve list, NOT filter. Use `tools` option or `disallowedTools` to restrict.
- SDK requires Zod 4 (`zod/v4` import path)

### Opus 4.6 features to leverage
- `thinking: { type: "adaptive" }` -- kernel uses adaptive thinking (replaces budget_tokens)
- `effort` parameter -- builder gets "max", researcher gets "low", kernel gets "high"
- Compaction API -- automatic context summarization for long kernel sessions. PreCompact hook writes state snapshot before compaction.
- Fast mode -- `speed: "fast"` for demo recordings (2.5x faster, premium pricing)
- 128K output -- builder can generate entire apps in one turn
- No prefill -- Opus 4.6 does NOT support assistant prefills (breaking change, use structured outputs or system prompt instead)
- 1M context window beta -- `betas: ["context-1m-2025-08-07"]`, tier 4+, 2x input above 200K. Use for extended build sessions if 200K proves insufficient.
- Prompt caching -- `cache_control: {type: "ephemeral"}` on system prompt + tool defs. 90% savings on repeated content ($0.50/MTok vs $5/MTok). 5-min TTL refreshes on use. Min 4096 tokens for Opus 4.6.

### Reference projects (open source, MIT)
- **OpenClaw/Moltbot** (v2026.2.9): 430K+ lines, TypeScript. Channel plugin architecture (`ChannelPlugin` interface, `ChannelManager`, 30+ channel adapters), `CronService`, `heartbeat-runner.ts` (1K lines, proactive agent wakeup with active hours, cron event injection), agent identity system. Repo: `../moltbot` (fork at FinnaAI/moltbot, upstream openclaw/openclaw).
- **Nanobot** (v0.1.3): ~3.5K lines, Python. `SOUL.md` (agent personality), `skills/` (markdown skill files with frontmatter), `HEARTBEAT.md` (periodic task file checked every 30min), `MessageBus` (decoupled channel routing), `SubagentManager`, `CronTool`. Repo: `../nanobot` (HKUDS/nanobot).
- Approach: **Inspire and rebuild** (Approach A from analysis). Port architectural patterns, don't copy code. Channel adapters are written fresh in TypeScript for the Matrix OS gateway. SOUL/skills/heartbeat/cron concepts are adapted to the "Everything Is a File" principle.

### Accepted risks
- V1 `query()` API is the kernel pattern (V2 drops critical options -- spike tested 2026-02-11)
- Voice is vision-first but implementation-last: acceptable for hackathon, demo script should not promise voice
- MCP inbound gateway: deferred (P2), not needed for demo
- Sharing workflow: architecturally enabled (apps are files), no explicit export/import UI
- WhatsApp adapter uses Baileys (unofficial library) -- may break with WhatsApp updates. Acceptable for hackathon.
- Channel adapters are simple (text-only initially) -- images, voice, files deferred to post-demo.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to user story for traceability
- Each phase has a checkpoint to validate before proceeding
- **TDD**: Test tasks (T007a-c, T013a-c, T100a-c, T106a-c, T120a-c) must pass before their implementation tasks start
- V1 `query()` with `resume` is the kernel pattern (spike-verified, see SDK-VERIFICATION.md)
- Pre-seeded apps are critical for demo pacing (30-90s generation is too slow for 3-min video)
- Git snapshots are cheap insurance -- commit early, commit often
- `bypassPermissions` propagates to all subagents -- use PreToolUse hooks for access control
- Opus 4.6: adaptive thinking, effort levels, compaction, fast mode, 128K output, no prefills, 1M context beta, prompt caching
- Zod 4 required by SDK (import from `zod/v4`)
- Test coverage target: 99-100% for kernel and gateway packages (`@vitest/coverage-v8`)
- Prompt caching: 90% input cost savings on system prompt + tool definitions across turns
- pnpm for installs, bun for running scripts
- **SOUL identity**: `~/system/soul.md` is L0 cache (always in prompt, never evicted). User can edit it to change the OS personality.
- **Skills**: markdown files with frontmatter, loaded at kernel boot. TOC in prompt, full body loaded on demand. Kernel can create new skills by writing files.
- **Channels**: adapters are gateway-level, route through existing dispatcher. Each channel+sender is a session. Config in `~/system/config.json`.
- **Cron**: jobs stored in `~/system/cron.json`. Kernel can create jobs via IPC tool. Gateway runs timer loop.
- **Heartbeat**: periodic kernel invocation. Reads `~/agents/heartbeat.md` for tasks. Picks up cron events. Active hours prevent night-time disturbance.
- **Cloud**: single container (gateway + shell). Channels connect outbound. Only web shell port needs exposing.
- **Channel priority**: Telegram first (simplest, HTTP polling, most common). WhatsApp second (Baileys bridge). Discord/Slack third (official SDKs).
