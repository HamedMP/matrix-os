# Tasks: Terminal Upgrade — Warp-Grade Features

**Input**: Design documents from `/specs/056-terminal-upgrade/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included (TDD is NON-NEGOTIABLE per constitution VIII)

**Organization**: Tasks grouped by user story (mapped from spec phases). Each story is independently testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US5)
- Exact file paths included in all descriptions

## Path Conventions

- **Backend**: `packages/gateway/src/`
- **Frontend**: `shell/src/components/terminal/`, `shell/src/stores/`
- **Tests**: `tests/gateway/`, `tests/shell/`

---

## Phase 1: Setup

**Purpose**: Install dependencies and create skeleton files

- [x] T001 Install xterm addon dependencies: `cd shell && pnpm add @xterm/addon-webgl @xterm/addon-search @xterm/addon-serialize`
- [x] T002 [P] Create empty module `packages/gateway/src/ring-buffer.ts` with `RingBuffer` class skeleton and exported types (`BufferChunk`)
- [x] T003 [P] Create empty module `packages/gateway/src/session-registry.ts` with `SessionRegistry` class skeleton and exported types (`SessionInfo`, `SessionHandle`)
- [x] T004 [P] Create empty module `shell/src/components/terminal/terminal-cache.ts` with `CachedTerminal` interface and cache function signatures
- [x] T005 [P] Create empty module `shell/src/components/terminal/terminal-themes.ts` with `AnsiPalette` interface and `getAnsiPalette` function signature
- [x] T006 [P] Create empty module `shell/src/components/terminal/web-link-provider.ts` with `WebLinkProvider` class skeleton
- [x] T007 [P] Create empty test files: `tests/gateway/ring-buffer.test.ts`, `tests/gateway/session-registry.test.ts`, `tests/gateway/terminal-ws.test.ts`, `tests/shell/terminal-cache.test.ts`, `tests/shell/terminal-themes.test.ts`, `tests/shell/web-link-provider.test.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Zod schemas for WS protocol validation — used by US1 and US2

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T008 Write failing tests for WS message validation schemas in `tests/gateway/terminal-ws.test.ts` — test `AttachNewSchema`, `AttachExistingSchema`, `InputSchema`, `ResizeSchema`, `DetachSchema` parse valid input, reject invalid input (bad UUID, negative seq, oversized data, missing fields)
- [x] T009 Implement Zod schemas in `packages/gateway/src/session-registry.ts` — `ClientMessageSchema` union with `AttachSchema`, `InputSchema`, `ResizeSchema`, `DetachSchema` per `contracts/websocket-protocol.md`. Import from `zod/v4`. Export schemas and inferred types.
- [x] T010 Run tests to verify T008 passes

**Checkpoint**: Zod schemas validated. User story implementation can begin.

---

## Phase 3: User Story 1 — Session Persistence (Priority: P1) MVP

**Goal**: PTY sessions persist across WebSocket disconnect. Ring buffer captures output for replay. Max 20 sessions with LRU eviction.

**Independent Test**: Open terminal via WS, send input, close WS, reconnect with `attach` + `sessionId`, verify buffered output is replayed with correct seq numbers.

### Tests for US1 (TDD — write first, verify they fail)

- [x] T011 [P] [US1] Write RingBuffer unit tests in `tests/gateway/ring-buffer.test.ts`
- [x] T012 [P] [US1] Write SessionRegistry unit tests in `tests/gateway/session-registry.test.ts`
- [x] T013 [P] [US1] Write WS protocol integration tests in `tests/gateway/terminal-ws.test.ts`
- [x] T014 Run all US1 tests to verify they FAIL (Red phase)
- [x] T015 [US1] Implement `RingBuffer` class in `packages/gateway/src/ring-buffer.ts`
- [x] T016 [US1] Run RingBuffer tests to verify they pass (Green phase)
- [x] T017 [US1] Implement `SessionRegistry` class in `packages/gateway/src/session-registry.ts`
- [x] T018 [US1] Implement `SessionHandle` in `packages/gateway/src/session-registry.ts`
- [x] T019 [US1] Run SessionRegistry tests to verify they pass
- [x] T020 [US1] Refactor `/ws/terminal` handler in `packages/gateway/src/server.ts`
- [x] T021 [US1] Add REST endpoints in `packages/gateway/src/server.ts`
- [x] T022 [US1] Run all US1 tests (unit + WS protocol) to verify they pass
- [x] T023 [US1] Commit: `feat(terminal): add session registry and ring buffer for persistent PTY sessions`

**Checkpoint**: PTY sessions survive WebSocket disconnect. Reconnect replays buffered output.

---

## Phase 4: User Story 2 — Terminal Caching + Session Reattach (Priority: P2)

**Goal**: Frontend caches xterm instances across tab switches (instant switching). On browser refresh, reattach to existing sessions and replay scrollback.

**Independent Test**: Open terminal, run command, switch tab and back (instant, no flash). Refresh browser — scrollback preserved. Close browser, reopen — layout + scrollback restored.

### Tests for US2 (TDD)

- [x] T024 [P] [US2] Write terminal-cache unit tests in `tests/shell/terminal-cache.test.ts`
- [x] T025 Run US2 tests to verify they FAIL
- [x] T026 [US2] Implement `terminal-cache.ts` in `shell/src/components/terminal/terminal-cache.ts`
- [x] T027 [US2] Run terminal-cache tests to verify they pass
- [x] T028 [US2] Add `sessionId?: string` to `PaneNode` type in `shell/src/stores/terminal-store.ts`. Add `setSessionId` method.
- [x] T029 [US2] Refactor `TerminalPane.tsx` for session protocol, caching, and reconnection
- [x] T030 [US2] Add WebSocket reconnection logic with exponential backoff (1s, 2s, 4s)
- [x] T031 [US2] Pass `sessionId` and `onSessionAttached` props to TerminalPane
- [x] T032 [US2] Add `setSessionId` method to `terminal-store.ts`
- [x] T033 [US2] Run all US2 tests — 115 tests passing
- [x] T034 [US2] Commit: `feat(terminal): add terminal caching and session reattach for persistent scrollback`

**Checkpoint**: Tab switching is instant. Browser refresh preserves scrollback.

---

## Phase 5: User Story 3 — WebGL Rendering (Priority: P3)

**Goal**: GPU-accelerated terminal rendering via WebGL addon. 5-10x speedup for heavy output. Automatic canvas 2D fallback.

**Independent Test**: Open terminal, run `cat` on a large file — rendering should be smooth. Check DevTools — WebGL context should be active.

### Implementation for US3

- [x] T035 [US3] Add WebGL addon loading to `TerminalPane.tsx` — after `FitAddon`, dynamically import `@xterm/addon-webgl`. Create `WebglAddon`, load onto terminal inside try/catch (fallback: log warning, continue with canvas 2D). Listen for `webglcontextlost` on terminal's canvas — dispose and recreate addon. Store in `CachedTerminal.webglAddon`.
- [x] T036 [US3] Commit: `feat(terminal): add WebGL GPU-accelerated rendering with canvas fallback`

**Checkpoint**: Terminal renders via WebGL. Fallback works if GPU unavailable.

---

## Phase 6: User Story 4 — In-Terminal Search (Priority: P4)

**Goal**: `Ctrl+Shift+F` opens a floating search bar. Find next/previous with match count and highlighting.

**Independent Test**: Open terminal with output, press `Ctrl+Shift+F`, type query, see matches highlighted with count indicator, Enter/Shift+Enter navigates matches, Escape closes.

### Implementation for US4

- [x] T037 [US4] Create `TerminalSearchBar.tsx` in `shell/src/components/terminal/TerminalSearchBar.tsx` — floating bar anchored top-right of pane container. Props: `searchAddon`, `isOpen`, `onClose`, `theme`. State: `query`, `caseSensitive`, `matchIndex`, `matchCount`. UI: text input (auto-focus on open), "N of M" indicator, case toggle button, prev/next buttons, close button. On query change: call `searchAddon.findNext(query, { caseSensitive })`. Enter: `findNext`. Shift+Enter: `findPrevious`. Escape: `clearDecorations()` + `onClose()`. Decoration colors from theme (warning at 40% for all matches, primary at 80% for active).
- [x] T038 [US4] Add search addon loading to `TerminalPane.tsx` — dynamically import `@xterm/addon-search`. Load onto terminal. Store in `CachedTerminal.searchAddon`. Add `searchOpen` state. Register `Ctrl+Shift+F` in `attachCustomKeyEventHandler` to toggle `searchOpen`. Render `<TerminalSearchBar>` inside pane container div when `searchOpen` is true.
- [x] T039 [US4] Commit: `feat(terminal): add in-terminal search with Ctrl+Shift+F`

**Checkpoint**: Search works with match highlighting and navigation.

---

## Phase 7: User Story 5 — Themes + Links + Copy/Paste + Serialize (Priority: P5)

**Goal**: Curated ANSI color palettes per OS theme, clickable URLs and file paths, Ctrl+Shift+C/V copy/paste, serialize addon wired up.

**Independent Test**: Switch OS theme — terminal ANSI colors update. Click URL in output — opens in new tab. Click file path — copies to clipboard. Ctrl+Shift+C copies selection, Ctrl+Shift+V pastes.

### Tests for US5 (TDD)

- [x] T040 [P] [US5] Write terminal-themes tests in `tests/shell/terminal-themes.test.ts` — known theme slug maps to correct palette, unknown theme falls back to luminance detection, dark background gets dark palette, light background gets light palette, all 9 palettes have complete 16-color set
- [x] T041 [P] [US5] Write web-link-provider tests in `tests/shell/web-link-provider.test.ts` — detect HTTP/HTTPS URLs, detect file paths with recognized extensions, detect `file:line` and `file:line:col` patterns, reject paths without recognized extensions, ignore partial matches inside words
- [x] T042 Run US5 tests to verify they FAIL

### Implementation for US5

- [x] T043 [US5] Implement `terminal-themes.ts` in `shell/src/components/terminal/terminal-themes.ts` — `AnsiPalette` interface. 9 curated palettes: one-dark, one-light, catppuccin-mocha, dracula, nord, solarized-dark, solarized-light, github-dark, github-light. `themeMapping` record from OS theme slug to palette name. `getAnsiPalette(themeSlug, backgroundHex)` checks mapping first, falls back to luminance detection.
- [x] T044 [US5] Run terminal-themes tests to verify they pass
- [x] T045 [US5] Update `buildXtermTheme` in `TerminalPane.tsx` — replace inline `DARK_ANSI`/`LIGHT_ANSI` constants (lines 7-43) with `getAnsiPalette(theme.slug, theme.colors.background)` import from `terminal-themes.ts`. Remove the `inferMode` function (moved into `getAnsiPalette`).
- [x] T046 [US5] Implement `web-link-provider.ts` in `shell/src/components/terminal/web-link-provider.ts` — class implementing xterm.js `ILinkProvider`. URL regex: `https?://[^\s<>"')\]]+`. File path regex with extension whitelist (`.ts`, `.js`, `.tsx`, `.jsx`, `.py`, `.rs`, `.go`, `.md`, `.json`, `.yaml`, `.yml`, `.toml`, `.css`, `.html`, `.sh`, `.sql`, `.rb`, `.java`, `.kt`, `.swift`, `.c`, `.cpp`, `.h`). Optional `:line` and `:line:col` suffix. Join consecutive wrapped lines before matching. URL action: `window.open(url, "_blank")`. File path action: copy to clipboard with notification. Hover: underline + tooltip.
- [x] T047 [US5] Run web-link-provider tests to verify they pass
- [x] T048 [US5] Register `WebLinkProvider` in `TerminalPane.tsx` — after terminal opens, call `terminal.registerLinkProvider(new WebLinkProvider())`.
- [x] T049 [US5] Add copy/paste shortcuts to `TerminalPane.tsx` — in `attachCustomKeyEventHandler`: `Ctrl+Shift+C` when selection exists → `navigator.clipboard.writeText(terminal.getSelection())` + brief 200ms selection flash. `Ctrl+Shift+V` → `navigator.clipboard.readText().then(text => ws.send({ type: "input", data: text }))`. `Ctrl+C` without Shift always passes through (SIGINT).
- [x] T050 [US5] Add serialize addon loading to `TerminalPane.tsx` — dynamically import `@xterm/addon-serialize`. Load onto terminal. No UI — just wired up for future export feature.
- [x] T051 [US5] Update `shell/src/components/terminal/index.ts` — export `TerminalSearchBar`, re-export types from `terminal-cache.ts` and `terminal-themes.ts`.
- [x] T052 [US5] Run all US5 tests to verify they pass
- [x] T053 [US5] Commit: `feat(terminal): add curated themes, clickable links, copy/paste, serialize addon`

**Checkpoint**: Full Warp-grade terminal experience. All 5 user stories complete.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final integration, cleanup, and validation

- [x] T054 Run full test suite: `bun run test` — 2906 passed, 43 pre-existing failures (unrelated)
- [x] T055 [P] Verify backward compatibility: existing `Terminal.tsx` standalone component unchanged, old WS protocol auto-creates session via 100ms timer
- [ ] T056 Run quickstart.md manual verification checklist (7 steps) — requires Docker
- [ ] T057 Commit: `feat(terminal): spec 056 terminal upgrade — all 5 user stories`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 — BLOCKS all user stories
- **Phase 3 (US1 — Session Persistence)**: Depends on Phase 2 — MVP
- **Phase 4 (US2 — Terminal Caching)**: Depends on US1 (needs session protocol)
- **Phase 5 (US3 — WebGL)**: Depends on Phase 2 only — can parallel with US1/US2
- **Phase 6 (US4 — Search)**: Depends on Phase 2 only — can parallel with US1/US2
- **Phase 7 (US5 — Themes/Links/Copy)**: Depends on Phase 2 only — can parallel with US1/US2
- **Phase 8 (Polish)**: Depends on all user stories

### User Story Dependencies

```
Phase 1 (Setup) → Phase 2 (Foundational)
                         ↓
              ┌──────────┼──────────┬──────────┐
              ↓          ↓          ↓          ↓
         US1 (P1)    US3 (P3)   US4 (P4)   US5 (P5)
              ↓       [parallel] [parallel] [parallel]
         US2 (P2)
              ↓
         Phase 8 (Polish)
```

- **US1 → US2**: Sequential (US2 needs session protocol from US1)
- **US3, US4, US5**: Independent of each other and of US1/US2. Can run in parallel after Phase 2.

### Parallel Opportunities

- T002-T007 (skeleton files): All parallel
- T011-T013 (US1 tests): All parallel
- T024, T040-T041 (US2+US5 tests): All parallel
- US3, US4, US5 implementation: All parallel (different files)

---

## Parallel Example: After Phase 2

```
Agent A (critical path):  US1 (T011-T023) → US2 (T024-T034) → Polish
Agent B (enhancements):   US3 (T035-T036) → US4 (T037-T039) → US5 (T040-T053)
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (Zod schemas)
3. Complete Phase 3: US1 — Session Persistence
4. **STOP and VALIDATE**: PTY survives WS disconnect, replay works
5. This alone is a major improvement over current behavior

### Incremental Delivery

1. Setup + Foundational → schemas validated
2. Add US1 (Session Persistence) → PTY sessions survive disconnect (MVP!)
3. Add US2 (Terminal Caching) → instant tab switching, scrollback survives refresh
4. Add US3 (WebGL) → GPU rendering
5. Add US4 (Search) → Ctrl+Shift+F
6. Add US5 (Themes/Links/Copy) → polished experience
7. Each story adds value without breaking previous stories
