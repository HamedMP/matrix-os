---
description: "Task list for 086 Matrix OS native macOS app"
---

# Tasks: Matrix OS Native macOS App (Kanban-with-Terminals Shell)

**Input**: `/specs/086-macos-native-shell/` (spec.md, plan.md, research.md, data-model.md, design.md)
**Tests**: REQUIRED (Constitution IX TDD — tests first, red→green→refactor).
**App root**: `macos/` (Swift 6 / SwiftUI, new top-level target). **Gateway delta**: `packages/gateway/`. **Gateway tests**: repo-root `tests/gateway/`.

## Format: `[ID] [P?] [Story] Description`
- **[P]** = parallelizable (different files, no dependency). **[Story]** = US1..US6.

---

## Phase 0: Spike Confirmations (de-risk; do first, cheap)

- [x] T001 [P] Confirm shell-WS route path and that it authenticates via `Authorization` header (not only query token); document in `research.md`. If header-auth is missing on the shell WS, add it in `packages/gateway/src/shell/` + `server.ts` (mirror canvas WS `requireRequestPrincipal(c)`), test-first in `tests/gateway/shell-ws-auth.test.ts`. (C1, S1)
- [x] T002 [P] Confirm whether `task.*` workspace events are delivered over a client-facing WS; if not, design the board-events subscription endpoint (bounded subscriber registry) — note decision in `research.md`. (C2, W1)
- [x] T003 [P] Confirm session archive = detach (not terminate) in `workspace-session-orchestrator.ts`; document semantics. (C3)
- [x] T004 [P] Confirm platform VPS endpoint-resolution + multi-VM selection contract (`packages/platform/src/customer-vps-routes.ts`, `/runtime`); document client flow. (C4, W2)

**Checkpoint**: all four confirmations resolved; any required gateway deltas have failing tests written.

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T010 Create `macos/` Swift package + Xcode project (`MatrixOS.xcodeproj`/`Package.swift`), macOS 14+ target, Swift 6 strict concurrency, app entrypoint window/scene.
- [ ] T011 [P] Add `SwiftTerm` dependency (terminal emulator) and `swift-format`/SwiftLint config.
- [ ] T012 [P] Bundle fonts (IBM Plex Sans + IBM Plex Mono) and add to the app bundle + Info.plist.
- [ ] T013 [P] Implement `DesignTokens.swift` (colors asset catalog, `Spacing`, `Radius`, `Motion`, `Font.plexSans/plexMono`) exactly per `design.md` §9; snapshot test the token values.
- [ ] T014 [P] CI: add a macOS build+test job (xcodebuild) for the `macos/` target; keep it separate from the pnpm/turbo pipeline.

---

## Phase 2: Foundational (BLOCKS all stories)

- [ ] T020 [US-all] Write failing unit tests for `GatewayHTTPClient` (bounded timeouts, principal header, generic-error mapping) in `macos/Tests/Net/GatewayHTTPClientTests.swift`.
- [ ] T021 [US-all] Implement `GatewayHTTPClient` (`URLSession`, `AbortSignal`-equivalent timeouts, `Authorization` header, no raw error leakage) in `macos/Sources/Net/`.
- [ ] T022 [US-all] [P] Write failing tests for `KeychainStore` + `PrincipalProvider` (device-auth token storage/retrieval/clear) in `macos/Tests/Net/`.
- [ ] T023 [US-all] Implement `KeychainStore` + `PrincipalProvider` + platform device-auth flow in `macos/Sources/Net/`.
- [ ] T024 [US-all] [P] Write failing tests for `ShellWSClient` resume logic (track `lastSeq`, reconnect with `fromSeq=lastSeq+1`, handle `replay-evicted`, bounded backoff) in `macos/Tests/Terminal/ShellWSClientTests.swift`.
- [ ] T025 [US-all] Implement `ShellWSClient` (`URLSessionWebSocketTask`, header auth, input/resize/detach/ping ↔ attached/output/exit/error/pong) in `macos/Sources/Terminal/`.
- [ ] T026 [US-all] [P] Implement `ConnectionProfile` + VPS resolver (platform endpoint resolution, multi-VM picker) in `macos/Sources/App/` with tests.
- [ ] T027 [US-all] [P] Implement core view models (`Card`, `SessionRef`, `Panel`) per `data-model.md` in `macos/Sources/Model/` with tests (bounded, value types).
- [ ] T028 [US-all] App shell: window, profile/onboarding gate, global keyboard map (`⌘N/⌘[/⌘]/⌘T/⌘1-3/Esc`), Reduce Motion/Transparency handling.

**Checkpoint**: networking + auth + WS client + tokens + design system ready; user stories can start in parallel.

---

## Phase 3: User Story 1 — Connect + work in a terminal (P1) 🎯 MVP

**Goal**: sign in → board of sessions → open card → terminal attaches with scrollback + live I/O.
**Independent Test**: attach to a real test zellij session, round-trip a command.

- [ ] T030 [P] [US1] Failing integration test: device-auth → resolve VPS → `GET /api/projects/:slug/tasks` renders cards (mock gateway) in `macos/Tests/Integration/BoardLoadTests.swift`.
- [ ] T031 [P] [US1] Failing integration test: open card → `ShellWSClient` attaches to `linkedSessionId`, scrollback replays, input echoes (test gateway + zellij) in `macos/Tests/Integration/TerminalAttachTests.swift`.
- [ ] T032 [US1] Implement read-only `BoardStore` (fetch tasks→cards, map status→columns, order) in `macos/Sources/Board/`.
- [ ] T033 [US1] Implement `BoardView`/`ColumnView`/`CardView` (LazyVStack recycling, OPERATOR design tokens, status badges, live edge-glow) in `macos/Sources/Board/`.
- [ ] T034 [US1] Implement `TerminalPanel` (SwiftTerm view bound to `ShellWSClient`, resume, resize-on-window-change, scrollback fade + LIVE marker) in `macos/Sources/Terminal/`.
- [ ] T035 [US1] Card → terminal open/close wiring; lazy attach only on open; detach on close (R1).
- [ ] T036 [US1] Empty/onboarding states: no-VPS, board loading skeleton, disconnected bar (per `design.md` §6.6).
- [ ] T037 [US1] Generic error surfacing for attach/list failures (no raw gateway text).

**Checkpoint**: MVP — native terminal client over remote zellij, no local PTY/DB. STOP & validate.

---

## Phase 4: User Story 2 — Board CRUD + live sync (P2)

**Goal**: create/move/reorder/rename/tag/archive cards; persisted to Postgres; <2s cross-client.
**Independent Test**: two clients converge; reload persists.

- [ ] T040 [P] [US2] (If T002 requires it) gateway: tags on task + board-events delivery — failing tests in `tests/gateway/` first, then implement (Kysely migration, route validation, atomic revision-guarded updates).
- [ ] T041 [P] [US2] Failing integration test: create card → session provisioned + task stored; move card → status/order PATCH; second client sees update via events.
- [ ] T042 [US2] Extend `BoardStore` with mutations (create/move/reorder/rename/tag/archive) using revision-guarded PATCH; optimistic UI with refresh-on-conflict.
- [ ] T043 [US2] Native drag-and-drop (Transferable/drop delegates) with insertion bar, column reflow springs, no layout shift; `⌘[`/`⌘]` move.
- [ ] T044 [US2] Subscribe to workspace/board events; diff-apply to `BoardStore`; bounded in-memory state.
- [ ] T045 [US2] Archive flow: default detach session, explicit-confirm terminate (C3).

**Checkpoint**: real task board, multi-device live.

---

## Phase 5: User Story 3 — Matrix Shell panel (P3)

- [ ] T050 [P] [US3] Failing test: Shell panel loads user's own shell origin authenticated; bearer never injected into web content.
- [ ] T051 [US3] `ShellPanel` (`WKWebView` to `SHELL_ORIGIN`, scoped-cookie auth handoff, re-auth on expiry, release on close) in `macos/Sources/Panels/`.
- [ ] T052 [US3] Panel switcher (Terminal·Shell·App) with `matchedGeometryEffect` (no layout shift), toggle consistency, light-dismiss, `⌘1/2/3`.

---

## Phase 6: User Story 4 — Matrix App panel (P4)

- [ ] T060 [P] [US4] Failing test: App panel loads via shell-origin `AppViewer` URL (server-side bridge serves it); un-bridged fetch blocked; no native bridge re-impl.
- [ ] T061 [US4] `AppPanel` (`WKWebView` to shell-origin AppViewer for selected app slug; app picker; suspend/release on switch) in `macos/Sources/Panels/`.

---

## Phase 7: User Story 5 — Symphony on the board (P5)

- [ ] T070 [P] [US5] Failing test: Symphony run read-model surfaces on related cards; start/observe via `symphony/proxy.ts`.
- [ ] T071 [US5] `SymphonyClient` + card run-status/agent-activity overlays + start/observe controls in `macos/Sources/Symphony/`.

---

## Phase 8: User Story 6 — CLI/MCP board control (P6)

- [ ] T080 [P] [US6] Failing tests for `matrix board` commands (list/create/move/update) against gateway under principal, in `tests/` (existing convention).
- [ ] T081 [US6] Implement `matrix board` command group (extend existing CLI) + MCP server exposing board read/write tools under the same principal; live-propagation to the app.

---

## Phase 9: Polish & Cross-Cutting

- [ ] T090 [P] Performance pass: verify 60fps board with 200+ cards (Instruments), coalesced terminal flushes, offscreen card suspension (R1).
- [ ] T091 [P] Accessibility: contrast, Reduce Motion/Transparency, color+shape state encoding, full keyboard nav.
- [ ] T092 [P] Aggregate resource caps verified (live attaches/web views bounded; scrollback eviction; timer teardown).
- [ ] T093 [P] Docs: `macos/README.md`, update repo docs; run `/update-docs`.
- [ ] T094 Security sweep: auth matrix honored on every call; no bearer in web content; generic errors only; `bun run check:patterns` for gateway delta.
- [ ] T095 react-doctor N/A (no React); ensure gateway delta passes `bun run typecheck` + `bun run test`.

---

## Dependencies & Execution Order

- **Phase 0** (spikes) → unblocks risky areas; do first.
- **Phase 1 Setup** → **Phase 2 Foundational** (BLOCKS all stories).
- **US1 (P1)** after Foundational = MVP. **US2..US6** after Foundational; can parallelize across agents but US4 depends on US3's panel switcher; US2's drag depends on US1's board.
- **Phase 9** after desired stories.

### Graphite Stack Plan
- **Stack 1**: Phase 0 spikes + Phase 1 setup + design tokens + docs.
- **Stack 2**: Phase 2 foundational (net/auth/WS/models) + any gateway delta.
- **Stack 3**: US1 MVP.  **Stack 4**: US2.  **Stack 5**: US3+US4 (panels).  **Stack 6**: US5.  **Stack 7**: US6.  **Final**: Phase 9.
- One PR per stack layer; respect PR size limits; Greptile 5/5 per layer; do not flatten.

### Parallel opportunities
- All Phase 0 tasks [P]. Phase 1 T011–T014 [P]. Phase 2 [P]-marked net/model tasks. Within each story, the failing tests [P] run together; models before views before wiring.

## Notes
- Tests fail first, then implement (TDD). Commit after each task or logical group.
- No local durable user data; no local PTY. Every external call has a bounded timeout.
- Validate each story independently at its checkpoint before moving on.
