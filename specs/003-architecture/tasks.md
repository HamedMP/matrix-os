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

- [ ] T001 Initialize monorepo with TypeScript strict mode, ESM, Node 22+ -- root `package.json` with pnpm workspaces for `packages/kernel`, `packages/gateway`, `shell/`
- [ ] T002 [P] Install kernel dependencies: `@anthropic-ai/claude-agent-sdk`, `drizzle-orm`, `better-sqlite3`, `zod@4`, `chokidar` in `packages/kernel/`
- [ ] T003 [P] Install gateway dependencies: `hono`, `@hono/node-server` in `packages/gateway/`
- [ ] T004 [P] Create Next.js 16 app in `shell/` with `create-next-app` -- App Router, TypeScript strict
- [ ] T005 [P] Configure tsx for backend dev server, bun for running scripts (`packages/kernel/`, `packages/gateway/`)
- [ ] T006 Create directory structure per plan.md -- `packages/`, `shell/`, `home/`, `tests/`, `spike/`
- [ ] T006b [P] Configure Vitest in root -- `vitest.config.ts` with workspaces, separate configs for unit tests (fast, no SDK) and integration tests (live SDK, haiku, tagged `@integration`). Add `test` and `test:integration` scripts. Enable `@vitest/coverage-v8` for coverage reporting, target 99-100% for kernel and gateway packages.

---

## Phase 2: Foundation (Blocking Prerequisites)

**Purpose**: SQLite/Drizzle, file system template, system prompt assembly. TDD: write tests first.

### Tests (write FIRST, must FAIL before implementation)

- [ ] T007a [P] [US1] Write `tests/kernel/schema.test.ts` -- test Drizzle schema: tasks table CRUD, messages table CRUD, indexes exist, WAL mode enabled
- [ ] T007b [P] [US1] Write `tests/kernel/prompt.test.ts` -- test `buildSystemPrompt()`: returns string, stays under 7K tokens, includes all L1 cache sections, handles missing files gracefully
- [ ] T007c [P] [US1] Write `tests/kernel/agents.test.ts` -- test frontmatter parser: valid YAML extracted, body preserved, `inject` field resolves knowledge files, unknown fields ignored, SDK `AgentDefinition` shape returned

### Implementation

- [ ] T007 [US1] Define Drizzle schema in `packages/kernel/src/schema.ts` -- tasks table, messages table with types and indexes (from SDK-VERIFICATION.md Section 7.2). Tasks table replaces `processes.json` as the source of truth for active processes.
- [ ] T008 [US1] Create SQLite database setup in `packages/kernel/src/db.ts` -- Drizzle ORM instance with better-sqlite3 driver, WAL mode, run migrations
- [ ] T009 [P] [US1] Create initial file system template in `home/` -- must include ALL files from FINAL-SPEC Section 6: `system/state.md`, `system/theme.json`, `system/layout.json`, `system/config.json`, `system/modules.json` (empty array), `system/session.json` (empty), `system/activity.log` (empty), `agents/system-prompt.md`, `agents/user-profile.md` (stub), `agents/heartbeat.md`, `agents/memory/long-term.md` (empty), `agents/custom/` (empty dir), `apps/`, `modules/`, `data/`, `projects/`, `tools/`, `sessions/`, `templates/`, `themes/`
- [ ] T010 [P] [US1] Write knowledge files: `home/agents/knowledge/app-generation.md`, `theme-system.md`, `module-standard.md`
- [ ] T011 [US1] Implement `buildSystemPrompt()` in `packages/kernel/src/prompt.ts` -- reads registers (system-prompt.md), L1 cache (state.md, modules.json, activity.log tail, knowledge TOC, agent TOC), user context (user-profile.md, memory/long-term.md). Must stay under 7K tokens. Note: kernel uses custom system prompt string (not `preset: "claude_code"`), sub-agents can optionally use preset.
- [ ] T012 [US1] Implement first-boot logic: copy `home/` to `~/matrixos/` (or configured path) if not exists, initialize git repo in the home directory
- [ ] T013 [P] [US1] Create markdown frontmatter parser for agent definition files -- parse YAML frontmatter + body from `~/agents/custom/*.md`. Note: `description`, `prompt`, `tools`, `model`, `maxTurns`, `disallowedTools`, `mcpServers` map to SDK `AgentDefinition` (v0.2.39+). `inject` and `mcp` are Matrix OS extensions handled by kernel code.

**Checkpoint**: All T007a-c tests pass green. `buildSystemPrompt()` returns a valid string under 7K tokens. Drizzle migrations run, tables created. File system template copies on first boot.

---

## Phase 3: Kernel -- US1 "Describe and it builds"

**Goal**: User sends a message via terminal/API, kernel routes it, builder creates an app, files appear on disk.

### Tests (write FIRST, must FAIL before implementation)

- [ ] T013a [P] [US1] Write `tests/kernel/ipc.test.ts` -- contract tests for all 7 MCP tools: `list_tasks` returns array, `claim_task` is atomic (prevents double-claim), `complete_task` stores output, `fail_task` sets error, `send_message` inserts row, `read_messages` marks as read, `read_state` returns summary. Test against in-memory SQLite.
- [ ] T013b [P] [US1] Write `tests/kernel/hooks.test.ts` -- test hook return shapes: `updateStateHook` returns `hookEventName`, `safetyGuardHook` denies dangerous commands, `gitSnapshotHook` is called on Write/Edit
- [ ] T013c [US1] Write `tests/kernel/kernel.integration.ts` -- `@integration` tagged: test full `spawnKernel()` -> MCP tool call -> result. Uses haiku. Tests: single turn works, resume preserves context, agent spawning works, hooks fire. Cost budget: <$0.20 per run.

### Core Kernel

- [ ] T014 [US1] Implement IPC MCP server in `packages/kernel/src/ipc.ts` -- `createSdkMcpServer` with 7 tools: `list_tasks`, `claim_task`, `complete_task`, `fail_task`, `send_message`, `read_messages`, `read_state` (backed by Drizzle queries). **Spike-verified**: V1 `query()` with MCP tools works (tested 2026-02-11).
- [ ] T015 [US1] Define core agent configs in `packages/kernel/src/agents.ts` -- builder (opus, effort: "max"), healer (sonnet), researcher (haiku, effort: "low"), deployer (sonnet), evolver (opus, effort: "high"). Each with SDK `AgentDefinition` fields: `description`, `prompt`, `tools`, `model`, `maxTurns`, `disallowedTools`. IPC tool subsets in `tools` array.
- [ ] T016 [US1] Implement `loadCustomAgents()` in `packages/kernel/src/agents.ts` -- scan `~/agents/custom/*.md`, parse frontmatter, resolve `inject` field (read knowledge files from `~/agents/knowledge/`, prepend to `prompt` string), resolve `mcp` field to `mcpServers` config at spawn time. Return SDK-compatible `AgentDefinition` objects.
- [ ] T017 [US1] Implement `kernelOptions()` in `packages/kernel/src/index.ts` -- custom system prompt with `cache_control: {type: "ephemeral"}` for prompt caching (90% savings on turns 2+), `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`, agents, mcpServers, hooks config, allowedTools, `thinking: { type: "adaptive" }` for Opus 4.6 adaptive thinking, effort level per context. Verify whether Agent SDK applies caching automatically or if explicit `cache_control` is needed on system prompt blocks.
- [ ] T018 [US1] Implement `spawnKernel()` in `packages/kernel/src/index.ts` -- V1 `query()` with `resume` option for multi-turn. Each turn: `query({ prompt, options: { ...kernelOptions, resume: sessionId } })`. Stream output via `for await`. Return session ID for next turn. **Spike-verified**: V1 query + resume + MCP tools + agents + bypassPermissions all work (tested 2026-02-11).

### Hooks

- [ ] T019 [P] [US1] Implement `updateStateHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Write|Edit, updates modules.json and state via Drizzle. Return `{ hookSpecificOutput: { hookEventName: input.hook_event_name } }`.
- [ ] T020 [P] [US1] Implement `logActivityHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Bash, appends to activity.log
- [ ] T021 [P] [US1] Implement `persistSessionHook` in `packages/kernel/src/hooks.ts` -- Stop hook, saves session ID to `~/system/session.json`. Must handle multi-session storage (multiple concurrent kernels each have their own session ID).
- [ ] T022 [P] [US1] Implement `gitSnapshotHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Write|Edit, git commit before mutations
- [ ] T023 [P] [US1] Implement `onSubagentComplete` in `packages/kernel/src/hooks.ts` -- SubagentStop hook. **SDK note**: `SubagentStopHookInput` does NOT include the subagent's result text. Read task output from SQLite IPC (where subagent called `complete_task`), correlate via `agent_id` -> `assigned_to`. Updates state.
- [ ] T024 [P] [US2] Implement `notifyShellHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Write|Edit, pushes file change events to shell via WebSocket (enables live desktop updates when kernel writes files)
- [ ] T025 [P] [US1] Implement `safetyGuardHook` in `packages/kernel/src/hooks.ts` -- PostToolUse on Bash, validates commands against safety rules (prevent `rm -rf /`, protect core OS paths)
- [ ] T025b [P] [US1] Implement `preCompactHook` in `packages/kernel/src/hooks.ts` -- PreCompact hook, writes state snapshot to `~/system/state.md` before compaction so summarized context includes a pointer to full state on disk. Ensures long sessions don't lose critical state.

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

## Phase 9: SOUL + Skills -- US7 "OS has personality and expandable capabilities"

**Goal**: The OS has an identity (personality, values, communication style) defined in `soul.md` that shapes all interactions. Skills are markdown files that expand what the OS can do, loadable at runtime. Inspired by Nanobot's `SOUL.md` / `skills/` and OpenClaw's agent identity system.

**Design**: SOUL is a file at `~/system/soul.md`. The kernel's `buildSystemPrompt()` reads it and prepends it to every prompt. Skills are markdown files at `~/agents/skills/*.md` with YAML frontmatter (name, description, triggers). The kernel loads them into its tool/context awareness. Skills are NOT tools -- they are prompt injections that teach the kernel new behaviors.

### Tests (TDD)

- [ ] T100a [P] [US7] Write `tests/kernel/soul.test.ts` -- test `loadSoul()`: returns soul content from file, returns empty string if file missing, stays under 500 tokens, content is included in `buildSystemPrompt()` output
- [ ] T100b [P] [US7] Write `tests/kernel/skills.test.ts` -- test `loadSkills()`: parses frontmatter from `~/agents/skills/*.md`, returns array of `{name, description, body}`, handles empty dir, handles malformed frontmatter gracefully
- [ ] T100c [P] [US7] Write `tests/gateway/channels/types.test.ts` -- test `ChannelAdapter` interface: `start()`, `stop()`, `send()` method shapes, `ChannelMessage` type validation

### Implementation

- [ ] T100 [US7] Create `home/system/soul.md` -- default SOUL identity for Matrix OS. Personality: helpful, direct, curious. Values: user privacy, accuracy, transparency. Communication: clear and concise, explains reasoning, asks when ambiguous. This is the "who am I" file the kernel reads on every boot.
- [ ] T101 [US7] Implement `loadSoul()` in `packages/kernel/src/soul.ts` -- reads `~/system/soul.md`, returns content string. Called by `buildSystemPrompt()` to prepend identity to system prompt. If file missing, returns empty string (graceful degradation).
- [ ] T102 [US7] Modify `buildSystemPrompt()` in `packages/kernel/src/prompt.ts` -- insert SOUL content after core identity section, before state/knowledge sections. SOUL content is always in L0 cache (never evicted).
- [ ] T103 [P] [US7] Implement `loadSkills()` in `packages/kernel/src/skills.ts` -- scans `~/agents/skills/*.md`, parses frontmatter (`name`, `description`, trigger keywords), returns skill definitions. Skills are injected as a "capabilities" section in the system prompt (TOC only, full body loaded on demand via `inject` pattern).
- [ ] T104 [P] [US7] Create initial skills: `home/agents/skills/summarize.md` (summarize text/conversations), `home/agents/skills/weather.md` (weather lookup via web search), `home/agents/skills/reminder.md` (create cron reminders), `home/agents/skills/skill-creator.md` (meta-skill: create new skill files)
- [ ] T105 [US7] Wire skills into kernel -- add skills TOC to system prompt, add `load_skill` to IPC tools so kernel can dynamically load full skill body when needed

**Checkpoint**: Kernel boots, reads `soul.md`, responds with personality. Ask "What skills do you have?" -- kernel lists available skills. Ask "Summarize this article" -- kernel loads summarize skill and executes it.

---

## Phase 10: Channels -- US8 "Message the OS from anywhere"

**Goal**: User sends a Telegram/WhatsApp/Discord/Slack message, it routes through the gateway to the kernel, response flows back to the channel. Each channel is a "shell" per Principle III. Channel config lives in `~/system/config.json` (Everything Is a File). Inspired by OpenClaw/Moltbot's `ChannelPlugin` architecture and Nanobot's `MessageBus`.

**Design**: `ChannelAdapter` interface with `start(config)`, `stop()`, `send(channelMessage)` methods. `ChannelManager` in gateway starts/stops adapters based on config. Inbound messages are normalized to `ChannelMessage { source: ChannelId, senderId: string, text: string, replyTo?: string }` and routed through the existing `dispatcher.dispatch()`. Responses are sent back via `adapter.send()`. Session management: each channel+sender combo maps to a conversation (reuses ConversationStore).

### Tests (TDD)

- [ ] T106a [P] [US8] Write `tests/gateway/channels/manager.test.ts` -- test `ChannelManager`: starts adapters from config, stops all on shutdown, routes inbound to dispatcher, routes outbound to correct adapter, handles adapter crash gracefully
- [ ] T106b [P] [US8] Write `tests/gateway/channels/telegram.test.ts` -- test Telegram adapter: config parsing, message normalization, send formatting (markdown to Telegram markdown), allowFrom filtering
- [ ] T106c [P] [US8] Write `tests/gateway/channels/message-format.test.ts` -- test `formatForChannel()`: converts kernel markdown to channel-appropriate format (Telegram MarkdownV2, Discord markdown, Slack mrkdwn, WhatsApp plain text)

### Core Infrastructure

- [ ] T106 [US8] Define `ChannelAdapter` interface in `packages/gateway/src/channels/types.ts`:
  ```typescript
  interface ChannelAdapter {
    id: ChannelId;
    start(config: ChannelConfig): Promise<void>;
    stop(): Promise<void>;
    send(msg: ChannelReply): Promise<void>;
    onMessage: (msg: ChannelMessage) => void; // set by manager
  }
  type ChannelId = "telegram" | "whatsapp" | "discord" | "slack";
  type ChannelMessage = { source: ChannelId; senderId: string; senderName?: string; text: string; chatId: string; replyToId?: string; };
  type ChannelReply = { chatId: string; text: string; replyToId?: string; };
  ```
- [ ] T107 [US8] Implement `ChannelManager` in `packages/gateway/src/channels/manager.ts` -- reads channel config from `~/system/config.json`, instantiates enabled adapters, sets `onMessage` callback that wraps inbound messages and calls `dispatcher.dispatch()`, routes kernel responses back to the originating adapter. Handles adapter lifecycle (start/stop/restart on config change).
- [ ] T108 [US8] Implement `formatForChannel()` in `packages/gateway/src/channels/format.ts` -- converts kernel markdown output to channel-appropriate format. Telegram: MarkdownV2 (escape special chars). Discord: native markdown (mostly passthrough). Slack: mrkdwn (convert `**bold**` to `*bold*`). WhatsApp: plain text with basic formatting.
- [ ] T109 [US8] Modify `dispatcher.ts` to accept `ChannelMessage` alongside existing WebSocket messages -- add `source` field to dispatch context so kernel knows which channel the message came from (injected into prompt as `[Channel: telegram, User: @username]`).
- [ ] T110 [US8] Add channel context to kernel prompt -- when message comes from a channel, prepend `[Channel: {id}] [User: {senderName}]` and append `channel-routing.md` knowledge file that instructs kernel on channel-appropriate response format.

### Telegram Adapter (first channel -- simplest, HTTP polling)

- [ ] T111 [US8] Implement Telegram adapter in `packages/gateway/src/channels/telegram.ts` -- uses `node-telegram-bot-api` in polling mode. Config: `{ token, allowFrom: string[] }`. Maps Telegram messages to `ChannelMessage`. Sends replies via `bot.sendMessage()` with `parse_mode: "MarkdownV2"`. Supports text messages only initially (images/voice deferred). `allowFrom` filters by Telegram user ID.
- [ ] T112 [US8] Add `channels` section to `home/system/config.json`:
  ```json
  { "channels": { "telegram": { "enabled": false, "token": "", "allowFrom": [] } } }
  ```

### WhatsApp Adapter

- [ ] T113 [US8] Implement WhatsApp adapter in `packages/gateway/src/channels/whatsapp.ts` -- inspired by Nanobot's Baileys bridge (`nanobot/bridge/`). Uses `@whiskeysockets/baileys` for direct connection (QR code pairing). Config: `{ enabled, authDir, allowFrom }`. Maps WhatsApp messages to `ChannelMessage`. Auth state persisted in `~/system/whatsapp-auth/`.
- [ ] T114 [P] [US8] Write WhatsApp QR login flow -- gateway exposes `GET /api/channels/whatsapp/qr` that returns current QR code for scanning. Web shell can display it.

### Discord Adapter

- [ ] T115 [US8] Implement Discord adapter in `packages/gateway/src/channels/discord.ts` -- uses `discord.js` with Gateway Intents (MESSAGE_CONTENT). Config: `{ enabled, token, allowFrom }`. Responds to DMs and @mentions in channels. Maps Discord messages to `ChannelMessage`.

### Slack Adapter

- [ ] T116 [US8] Implement Slack adapter in `packages/gateway/src/channels/slack.ts` -- uses `@slack/bolt` in Socket Mode (no public URL needed). Config: `{ enabled, botToken, appToken, allowFrom }`. Responds to DMs and @mentions. Maps Slack messages to `ChannelMessage`.

### Gateway Integration

- [ ] T117 [US8] Wire `ChannelManager` into gateway startup in `packages/gateway/src/server.ts` -- instantiate after watcher, start channels, stop on SIGTERM. Add `GET /api/channels/status` endpoint (returns which channels are connected).
- [ ] T118 [US8] Add channel status to shell -- show connected channels in ActivityFeed or a new status indicator (green dots for connected channels).
- [ ] T119 [P] [US8] Create `home/agents/knowledge/channel-routing.md` -- instructions for kernel on how to format responses for different channels (shorter for Telegram, code blocks for Discord, plain for WhatsApp).

**Checkpoint**: Configure Telegram token in `config.json`, restart gateway. Send message to bot from Telegram. Kernel processes it, responds in Telegram with properly formatted text. Same message appears in web shell's conversation history (shared state). `GET /api/channels/status` shows `telegram: connected`.

---

## Phase 11: Cron + Heartbeat -- US9 "OS is proactive"

**Goal**: The OS doesn't just wait for input -- it proactively reaches out. Cron handles scheduled tasks (reminders, recurring checks). Heartbeat is a periodic kernel invocation that reads `heartbeat.md` and acts on pending tasks. Inspired by OpenClaw's `CronService` + `heartbeat-runner` and Nanobot's `HEARTBEAT.md` + cron tool.

**Design**: Cron jobs stored in `~/system/cron.json` (Everything Is a File). Heartbeat reads `~/agents/heartbeat.md` every N minutes and invokes the kernel with the heartbeat prompt. Cron triggers are system events injected into the kernel's next heartbeat or immediate invocation. Both are gateway-level concerns (timers that invoke the kernel).

### Tests (TDD)

- [ ] T120a [P] [US9] Write `tests/gateway/cron/service.test.ts` -- test `CronService`: add job, remove job, list jobs, trigger fires at correct time, persists to `cron.json`, survives restart, deduplicates job IDs
- [ ] T120b [P] [US9] Write `tests/gateway/cron/store.test.ts` -- test cron store: CRUD on `cron.json`, handles corrupt file, atomic writes
- [ ] T120c [P] [US9] Write `tests/gateway/heartbeat/runner.test.ts` -- test `HeartbeatRunner`: invokes kernel on interval, skips if kernel already active, reads heartbeat.md content, injects cron events, respects active hours

### Cron Service

- [ ] T120 [US9] Implement `CronService` in `packages/gateway/src/cron/service.ts` -- manages scheduled jobs. Each job: `{ id, name, message, schedule: { type: "cron" | "interval" | "once", cron?: string, intervalMs?: number, at?: string }, target?: { channel?: ChannelId, chatId?: string }, createdAt }`. Uses `node-cron` for cron expressions, `setInterval` for intervals, `setTimeout` for one-shot. On trigger: enqueues a system event for heartbeat to pick up, or dispatches immediately to kernel.
- [ ] T121 [US9] Implement cron store in `packages/gateway/src/cron/store.ts` -- reads/writes `~/system/cron.json`. Atomic writes (write temp + rename). Load on startup, save on mutation.
- [ ] T122 [US9] Add `cron` IPC tool to kernel's MCP server -- allows the kernel itself to create/remove cron jobs:
  ```
  cron({ action: "add" | "remove" | "list", name?, message?, schedule?, jobId? })
  ```
  This enables: "Remind me to drink water every 2 hours" -> kernel creates cron job -> cron service fires every 2h -> heartbeat relays to user.
- [ ] T123 [P] [US9] Create `home/system/cron.json` -- empty array `[]` in home template

### Heartbeat Runner

- [ ] T124 [US9] Implement `HeartbeatRunner` in `packages/gateway/src/heartbeat/runner.ts` -- fires every N minutes (configurable, default 30m). On fire: reads `~/agents/heartbeat.md`, checks `~/system/cron.json` for pending events, builds heartbeat prompt, invokes kernel via `dispatcher.dispatch()` with `{ source: "heartbeat" }`. Kernel responds with actions (send message to channel, update state, etc.).
- [ ] T125 [US9] Implement heartbeat prompt builder in `packages/gateway/src/heartbeat/prompt.ts` -- constructs the heartbeat prompt: includes `heartbeat.md` content, pending cron events, current time, channel status. Instructs kernel: "Review your pending tasks. If there's nothing to do, respond with HEARTBEAT_OK. If there are tasks, execute them."
- [ ] T126 [US9] Add active hours support -- heartbeat only fires between configured hours (e.g., 8am-10pm user's timezone). Config in `~/system/config.json`: `{ heartbeat: { enabled: true, everyMinutes: 30, activeHours: { start: "08:00", end: "22:00", timezone: "Europe/Stockholm" } } }`.
- [ ] T127 [US9] Wire heartbeat responses to channels -- if heartbeat kernel invocation produces a message targeted at a channel (e.g., "Send morning summary to telegram"), route it through `ChannelManager.send()`.

### Gateway Integration

- [ ] T128 [US9] Wire cron + heartbeat into gateway startup -- start `CronService` and `HeartbeatRunner` after channels. Stop on SIGTERM. Add status to `GET /health`.
- [ ] T129 [US9] Add `heartbeat.md` default content to home template -- default tasks: `- [ ] Check if any modules need health checks`, `- [ ] Review pending reminders`. User and kernel can add/remove tasks from this file.

**Checkpoint**: Start gateway. After 30 minutes (or with `everyMinutes: 1` for testing), heartbeat fires, kernel reads heartbeat.md, reports "HEARTBEAT_OK" in activity log. Create a cron job: ask kernel "Remind me to stretch every hour". Cron job appears in `cron.json`. After interval, heartbeat picks it up, sends reminder to configured channel (or web shell if no channel).

---

## Phase 12: Cloud Deployment -- US10 "Always on, always reachable"

**Goal**: Matrix OS runs as a service on a cloud VM, accessible from the web and all configured channels. Includes Dockerfile, systemd service file, environment variable configuration, and basic security (auth token for web shell).

**Design**: Single Docker container runs gateway + shell. Channels connect outbound (Telegram polling, WhatsApp WebSocket, Discord WebSocket, Slack Socket Mode) so no inbound ports needed beyond the web shell port. Cloud VM only needs port 443 exposed (reverse proxy via Caddy/nginx).

- [ ] T130 [US10] Create `Dockerfile` -- multi-stage build: install deps, build gateway + shell, copy home template. Single `CMD` starts gateway (which serves shell via reverse proxy). Exposes port 4000.
- [ ] T131 [P] [US10] Create `docker-compose.yml` -- gateway + shell service, volume mount for `~/matrixos/` data persistence, env vars for API keys and channel tokens.
- [ ] T132 [P] [US10] Create `matrixos.service` systemd unit file -- for running on bare-metal or VM without Docker. `ExecStart`, `Restart=always`, `EnvironmentFile=/etc/matrixos/env`.
- [ ] T133 [US10] Add auth token middleware to gateway -- `MATRIX_AUTH_TOKEN` env var. If set, all HTTP/WebSocket connections must include `Authorization: Bearer <token>` header. Channels are exempt (they use their own auth). Protects web shell on public internet.
- [ ] T134 [P] [US10] Create `scripts/setup-server.sh` -- installs Node.js 22, pnpm, clones repo, builds, creates systemd service, prompts for API keys. For quick cloud VM setup.
- [ ] T135 [P] [US10] Add `GET /api/system/info` endpoint -- returns OS version, uptime, connected channels, active modules, disk usage. For remote monitoring.
- [ ] T136 [US10] Document cloud deployment in `docs/deployment.md` -- step-by-step for DigitalOcean/Hetzner/Fly.io, env var reference, channel setup from remote, backup/restore.

**Checkpoint**: `docker compose up` on a cloud VM. Web shell accessible at `https://my-matrix-os.example.com`. Telegram bot responds from the same server. Heartbeat fires, sends morning summary to Telegram. All data persists in mounted volume.

---

## Dependencies and Execution Order

### Phase Dependencies

```
Phase 1 (Setup) ─────────────> Phase 2 (Foundation)
                                    |
                                    v
                               Phase 3 (Kernel / US1)
                                    |
                          ┌─────────┼─────────────────┐
                          v         v                  v
                     Phase 4    Phase 5    Phase 7   Phase 9
                     (Shell)   (Healing)  (Multiproc) (SOUL+Skills)
                       US2       US3        US5        US7
                       |          |                     |
                       v          |                     v
                  Phase 4b        |              Phase 10 (Channels)
                  (History)       |                US8
                       |          |                     |
                       v          |                     v
                  Phase 4c        |              Phase 11 (Cron+Heartbeat)
                  (Interaction)   |                US9
                       |          |                     |
                       v          |                     v
                  Phase 4d        |              Phase 12 (Cloud Deploy)
                  (Polish)        |                US10
                       |          |
                       v          v
                     Phase 6 (Evolution / US4)
                          |
                          v
                     Phase 8 (Polish + Demo)
```

### Critical Path (Hackathon Demo)

Setup -> Foundation -> Kernel -> Shell -> 4b -> 4c -> 4d -> Phase 5 (healing) -> Phase 8 (demo)

### Personal Assistant Path (new)

Setup -> Foundation -> Kernel -> Phase 9 (SOUL+Skills) -> Phase 10 (Channels) -> Phase 11 (Cron+Heartbeat) -> Phase 12 (Cloud)

These two paths can run **in parallel** after Phase 3 (Kernel). The visual OS path (Phases 4-6) and the personal assistant path (Phases 9-12) are independent until Phase 8 (demo) which showcases both.

~136 tasks (T001-T136 + TDD test tasks).

### Parallel Opportunities

- Phase 4 (Shell), Phase 5 (Healing), Phase 7 (Multiprocessing), and Phase 9 (SOUL+Skills) can all run in parallel after Phase 3
- Phase 9 -> Phase 10 -> Phase 11 -> Phase 12 are sequential (each builds on the previous)
- Phase 10 channel adapters (T111-T116) are parallelizable with each other
- Phase 11 cron (T120-T123) and heartbeat (T124-T127) are parallelizable
- Phase 12 tasks (T130-T136) are mostly parallelizable
- All [P] tasks within a phase can run in parallel

### MVP Path (Visual OS: US1 + US2)

1. Phase 1-3: Setup, Foundation, Kernel
2. Phase 4-4d: Web Shell (desktop, history, interaction, polish)
3. Phase 5: Self-healing
4. Phase 8: Demo

### Full Product Path (OS + Personal Assistant: US1-US10)

1. Phase 1-3: Setup, Foundation, Kernel
2. Phase 4-4d: Web Shell (parallel with Phase 9-11)
3. Phase 9: SOUL + Skills (personality, expandable capabilities)
4. Phase 10: Channels (Telegram first, then WhatsApp/Discord/Slack)
5. Phase 11: Cron + Heartbeat (proactive behavior)
6. Phase 5-6: Self-healing, Self-evolution
7. Phase 12: Cloud deployment
8. Phase 8: Demo (showcases both visual OS and multi-channel assistant)

This gives the complete vision: Matrix OS is both the operating system for your digital life (visual desktop, app generation, self-healing) and your personal AI assistant (reachable from any channel, proactive, always learning). Run it locally or on a cloud server -- interact visually or conversationally.

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
