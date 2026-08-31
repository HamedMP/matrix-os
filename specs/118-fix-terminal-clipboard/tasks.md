# Tasks: Reliable Terminal Clipboard and Selection

**Input**: Design documents from `/specs/118-fix-terminal-clipboard/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/terminal-clipboard-interactions.md`, `quickstart.md`

**Tests**: Required. The specification mandates TDD and automated coverage for shortcuts, real xterm event ordering, mouse-aware applications, context menus, Select All, failures, multiple panes, and Canvas zoom.

**Organization**: Tasks are grouped by user story. Within every story, complete and observe the failing tests before changing production code, then run the story checkpoint before continuing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: May run in parallel after its stated phase dependencies because it touches different files.
- **[Story]**: Maps directly to a user story in `spec.md`.
- Every task names the file or repository path it owns.

---

## Phase 1: Setup and Delivery Safety

**Purpose**: Confirm the existing manual worktree, project hygiene, and review workflow before implementation.

- [x] T001 Verify branch `118-fix-terminal-clipboard`, manual worktree `/home/nima/matrix-os/.worktrees/fix-terminal-clipboard-selection`, complete `specs/118-fix-terminal-clipboard/checklists/requirements.md`, and unchanged unrelated user work before editing
- [x] T002 Verify Node/TypeScript/Docker/ESLint/Prettier ignore coverage in `.gitignore`, `.dockerignore`, `eslint.config.mjs`, and `.prettierignore`; append only missing critical generated, secret, coverage, and build patterns
- [x] T003 Verify Graphite is installed, authenticated, and initialized for the current manual worktree using `docs/dev/stacked-prs.md` and `.git/.graphite_repo_config`; stop stack operations if readiness fails

**Checkpoint**: Repository hygiene and the Graphite delivery path are verified; do not initialize dependencies or add packages because the plan requires none.

---

## Phase 2: Foundational Shared Interaction Policy

**Purpose**: Establish the DOM-independent shortcut and pointer-routing contract that blocks all renderer stories.

**⚠️ CRITICAL**: No user-story production implementation starts until the shared policy tests are red, the policy is implemented, and its package exports typecheck.

- [x] T004 Write failing contract tests for exact Command/Ctrl shortcuts, composing/repeat/modifier rejection, copy-without-selection behavior, and selection-aware pointer shielding in `tests/contracts/terminal-clipboard.test.ts`
- [x] T005 Implement typed shortcut classification, clipboard action/result types, and pointer protection decisions without browser, React, xterm, transport, or clipboard content dependencies in `packages/contracts/src/terminal-clipboard.ts`
- [x] T006 Export the shared terminal clipboard policy through `packages/contracts/package.json` and `packages/contracts/src/index.ts`
- [x] T007 Run the focused contract test and contracts typecheck for `tests/contracts/terminal-clipboard.test.ts` and `packages/contracts/tsconfig.json`, fixing only foundational-policy failures

**Checkpoint**: Shared policy is green and reviewable. Preserve this phase as Graphite layer 1 before user-story changes.

---

## Phase 3: User Story 1 — Copy and Paste with Mac Shortcuts (Priority: P1) 🎯 MVP

**Goal**: Command+C, Command+Shift+C, and Command+V work exactly once in the focused terminal while existing Ctrl+Shift and non-terminal behavior remain intact.

**Independent Test**: With two terminals open, copy known multiline/Unicode text with both macOS shortcuts and paste known text into the focused pane; clipboard/input values match exactly, Paste adds no Enter, key repeat does not duplicate, and focus outside the terminal retains normal behavior.

### Tests for User Story 1 — write and observe RED first

- [ ] T008 [P] [US1] Add failing native shortcut, exact-selection, exactly-once paste, repeat, no-selection, and focused-pane tests in `tests/desktop/terminal-view.test.tsx`
- [ ] T009 [P] [US1] Add failing typed Copy success/unavailable/fallback tests in `tests/desktop/terminal-link-actions.test.ts`
- [ ] T010 [P] [US1] Add failing web Command/Ctrl shortcut, selection-preservation, exactly-once paste, shell-precedence, and focused-pane tests in `tests/shell/terminal-pane-clipboard.test.tsx`
- [ ] T011 [P] [US1] Extend text/image/empty/unavailable result and send-once tests in `tests/shell/terminal-rich-paste.test.ts`
- [ ] T012 [P] [US1] Preserve standard non-terminal native Edit behavior with regression assertions in `tests/desktop/menu-template.test.ts`

### Implementation for User Story 1

- [ ] T013 [US1] Return bounded typed Copy outcomes while preserving the existing fallback path in `desktop/src/renderer/src/features/terminal/terminal-link-actions.ts`
- [ ] T014 [US1] Classify and execute Command+C, Command+Shift+C, Command+V, and existing Ctrl+Shift shortcuts against the initiating xterm/session exactly once, without clearing selection or auto-submitting, in `desktop/src/renderer/src/features/terminal/TerminalView.tsx` and `desktop/src/renderer/src/features/terminal/terminal-rich-paste.ts`
- [ ] T015 [US1] Return accurate text/image/empty/unavailable/failed send outcomes from `shell/src/components/terminal/terminal-rich-paste.ts`
- [ ] T016 [US1] Classify and execute macOS and existing Ctrl+Shift terminal clipboard shortcuts against the focused pane, consume only handled events, and keep selection after Copy in `shell/src/components/terminal/TerminalPane.tsx`
- [ ] T017 [US1] Run all User Story 1 tests in `tests/contracts/terminal-clipboard.test.ts`, `tests/desktop/terminal-view.test.tsx`, `tests/desktop/terminal-link-actions.test.ts`, `tests/desktop/menu-template.test.ts`, `tests/shell/terminal-pane-clipboard.test.tsx`, and `tests/shell/terminal-rich-paste.test.ts`

**Checkpoint**: Shortcut-only MVP is independently usable in native and web terminals. Preserve this phase as Graphite layer 2.

---

## Phase 4: User Story 2 — Preserve the Intended Selection on Right-Click (Priority: P1)

**Goal**: Right-click keeps the complete visible selection, enables Copy, and copies the immutable multiline/wrapped/Unicode snapshot rather than the hovered word.

**Independent Test**: Select a known multi-row passage, dispatch contextmenu on the inner xterm element at several selected positions, choose Copy, and verify the clipboard equals the original range while dismissing the menu leaves selection and valid focus intact.

### Tests for User Story 2 — write and observe RED first

- [ ] T018 [P] [US2] Upgrade the fake native xterm to install an inner child contextmenu mutation listener and add failing capture-order, `rightClickSelectsWord`, immutable-selection, and Copy-enablement tests in `tests/desktop/terminal-view.test.tsx`
- [ ] T019 [P] [US2] Add failing immutable snapshot, Copy enablement, Escape/light-dismiss, and origin-focus restoration tests in `tests/desktop/terminal-link-context-menu.test.tsx`
- [ ] T020 [P] [US2] Add failing general terminal Copy/Select All menu, optional-link action, immutable snapshot, and focus-restoration tests in `tests/shell/terminal-link-context-menu.test.tsx`
- [ ] T021 [P] [US2] Add failing web inner-xterm context capture and exact multiline/right-click Copy tests in `tests/shell/terminal-pane-clipboard.test.tsx`

### Implementation for User Story 2

- [ ] T022 [P] [US2] Set `rightClickSelectsWord: false`, capture secondary/contextmenu before xterm, snapshot full xterm selection, and restore still-valid origin focus in `desktop/src/renderer/src/features/terminal/TerminalView.tsx` and `desktop/src/renderer/src/features/terminal/TerminalLinkContextMenu.tsx`
- [ ] T023 [P] [US2] Generalize the web link-only menu to terminal Copy/Select All plus optional link actions, set `rightClickSelectsWord: false`, and capture the immutable selection before xterm in `shell/src/components/terminal/TerminalPane.tsx` and `shell/src/components/terminal/TerminalLinkContextMenu.tsx`
- [ ] T024 [US2] Run all User Story 2 tests in `tests/desktop/terminal-view.test.tsx`, `tests/desktop/terminal-link-context-menu.test.tsx`, `tests/shell/terminal-pane-clipboard.test.tsx`, and `tests/shell/terminal-link-context-menu.test.tsx`

**Checkpoint**: Context-menu Copy is trustworthy and independently testable across both xterm implementations.

---

## Phase 5: User Story 3 — Keep Selection Stable in Mouse-Aware Terminal Apps (Priority: P1)

**Goal**: Passive SGR mouse movement and right-button reports cannot clear a completed selection, while TUI mouse behavior resumes unchanged when no selection exists.

**Independent Test**: Enable SGR any-motion reporting, select multiline output, move the pointer for at least ten seconds, and verify the exact selection remains; deliberately clear it and verify subsequent mouse reports reach the terminal transport.

### Tests for User Story 3 — write and observe RED first

- [ ] T025 [P] [US3] Extend the native xterm fake with SGR passive-movement user-input clearing and add failing no-button movement, secondary-button, deliberate-left-action, and resume-after-clear tests in `tests/desktop/terminal-view.test.tsx`
- [ ] T026 [P] [US3] Add failing web selection-shield and no-selection TUI-report tests using the real pointer-listener path in `tests/shell/terminal-pane-scrolling.test.tsx`
- [ ] T027 [P] [US3] Extend pure edge cases for button bitmasks, movement, secondary down/up, and deliberate left actions in `tests/contracts/terminal-clipboard.test.ts`

### Implementation for User Story 3

- [ ] T028 [P] [US3] Install and clean up a capture-phase selection shield that blocks only passive movement and secondary reports while selection exists in `desktop/src/renderer/src/features/terminal/TerminalView.tsx`
- [ ] T029 [P] [US3] Integrate the same selection-aware shield ahead of existing Canvas pointer correction without per-move React state in `shell/src/components/terminal/TerminalPane.tsx`
- [ ] T030 [US3] Run all User Story 3 tests in `tests/contracts/terminal-clipboard.test.ts`, `tests/desktop/terminal-view.test.tsx`, and `tests/shell/terminal-pane-scrolling.test.tsx`

**Checkpoint**: All P1 journeys (shortcuts, right-click fidelity, and Codex/mouse-aware stability) are complete. Preserve User Stories 2–3 as Graphite layer 3.

---

## Phase 6: User Story 4 — Select All Remains Usable (Priority: P2)

**Goal**: Select All uses xterm scrollback, remains selected through passive movement, and yields identical text through keyboard and menu Copy.

**Independent Test**: Populate visible output and scrollback, invoke Select All, move the pointer for ten seconds, then compare keyboard and menu clipboard values; an empty buffer shows no misleading Copy availability.

### Tests for User Story 4 — write and observe RED first

- [ ] T031 [P] [US4] Add failing native Command+A/menu Select All, scrollback selection, passive-motion stability, empty-buffer, and Copy parity tests in `tests/desktop/terminal-view.test.tsx` and `tests/desktop/terminal-link-context-menu.test.tsx`
- [ ] T032 [P] [US4] Add failing web Command+A/menu Select All, scrollback selection, passive-motion stability, empty-buffer, and Copy parity tests in `tests/shell/terminal-pane-clipboard.test.tsx` and `tests/shell/terminal-link-context-menu.test.tsx`

### Implementation for User Story 4

- [ ] T033 [P] [US4] Route native Command+A and menu Select All to the originating `terminal.selectAll()` and preserve focus/selection in `desktop/src/renderer/src/features/terminal/TerminalView.tsx` and `desktop/src/renderer/src/features/terminal/TerminalLinkContextMenu.tsx`
- [ ] T034 [P] [US4] Route web Command+A and menu Select All to the originating `terminal.selectAll()` and preserve focus/selection in `shell/src/components/terminal/TerminalPane.tsx` and `shell/src/components/terminal/TerminalLinkContextMenu.tsx`
- [ ] T035 [US4] Run all User Story 4 tests in `tests/desktop/terminal-view.test.tsx`, `tests/desktop/terminal-link-context-menu.test.tsx`, `tests/shell/terminal-pane-clipboard.test.tsx`, and `tests/shell/terminal-link-context-menu.test.tsx`

**Checkpoint**: Select All is independently usable in native and web terminals.

---

## Phase 7: User Story 5 — Consistent Behavior Across Shell Layouts (Priority: P2)

**Goal**: Clipboard and selection behavior remains pane-local and geometrically correct in native/web Canvas and Desktop modes at all specified interactive zooms.

**Independent Test**: Repeat selection, right-click Copy, keyboard Copy, Paste, focus switch, and zoom-after-selection journeys in native Canvas 0.5/1/2, web Canvas 0.25/0.5/1/1.5/3, and both Desktop modes without xterm remount or selection drift.

### Tests for User Story 5 — write and observe RED first

- [ ] T036 [P] [US5] Add failing native Canvas scale-forwarding and terminal-no-remount assertions in `tests/desktop/native-desktop-shell.test.tsx` and `tests/desktop/terminals-tab.test.tsx`
- [ ] T037 [P] [US5] Add failing native transformed pointer/contextmenu boundary tests at scale 0.5, 1, and 2 in `tests/desktop/terminal-view.test.tsx`
- [ ] T038 [P] [US5] Extend web pointer math, raw contextmenu coordinate, no-double-unscale, and selection-preservation tests at zoom 0.25, 0.5, 1, 1.5, and 3 in `tests/shell/terminal-pane-zoom-correction.test.ts`
- [ ] T039 [P] [US5] Add failing web Canvas scale forwarding, below-0.25 preview return, and terminal-no-remount assertions in `tests/shell/canvas-window-terminal-overlay.test.tsx`

### Implementation for User Story 5

- [ ] T040 [P] [US5] Forward native Canvas `visualScale` through `desktop/src/renderer/src/features/mission-control/TabContent.tsx` and `desktop/src/renderer/src/features/terminal/TerminalsTab.tsx` into `desktop/src/renderer/src/features/terminal/TerminalView.tsx` without recreating xterm
- [ ] T041 [P] [US5] Keep xterm cell-event correction separate from raw menu placement/link hit testing and preserve instances across web zoom transitions in `shell/src/components/terminal/TerminalPane.tsx` and `shell/src/components/canvas/CanvasWindow.tsx`
- [ ] T042 [US5] Run all User Story 5 tests in `tests/desktop/native-desktop-shell.test.tsx`, `tests/desktop/terminals-tab.test.tsx`, `tests/desktop/terminal-view.test.tsx`, `tests/shell/terminal-pane-zoom-correction.test.ts`, and `tests/shell/canvas-window-terminal-overlay.test.tsx`

**Checkpoint**: Canvas/Desktop parity is independently verified. Preserve User Stories 4–5 as Graphite layer 4.

---

## Phase 8: User Story 6 — Recover Safely from Clipboard Failure (Priority: P3)

**Goal**: Clipboard denial, absence, disconnect, stale ownership, and retry paths provide safe feedback, preserve selection, and never partially or doubly paste.

**Independent Test**: Reject clipboard read/write, disconnect or replace the initiating pane before resolution, and retry after recovery; failures expose only generic text, Copy retains selection, Paste writes zero bytes, and retry succeeds once.

### Tests for User Story 6 — write and observe RED first

- [ ] T043 [P] [US6] Add failing native clipboard denial, fallback failure, generic feedback, selection retention, stale-session cancellation, unmount, and exactly-once retry tests in `tests/desktop/terminal-link-actions.test.ts` and `tests/desktop/terminal-view.test.tsx`
- [ ] T044 [P] [US6] Add failing web clipboard denial, disconnected transport, stale-pane cancellation, generic feedback, zero-write failure, and exactly-once retry tests in `tests/shell/terminal-rich-paste.test.ts` and `tests/shell/terminal-pane-clipboard.test.tsx`
- [ ] T045 [US6] Add privacy assertions that UI and diagnostics never contain selected text, clipboard text, raw errors, provider details, paths, filenames, or session IDs in `tests/desktop/terminal-view.test.tsx` and `tests/shell/terminal-pane-privacy.test.tsx` after T043–T044

### Implementation for User Story 6

- [ ] T046 [P] [US6] Add bounded native clipboard operation state, safe generic feedback, and session-generation/unmount cancellation in `desktop/src/renderer/src/features/terminal/TerminalView.tsx`, `desktop/src/renderer/src/features/terminal/terminal-link-actions.ts`, and `desktop/src/renderer/src/features/terminal/terminal-rich-paste.ts`
- [ ] T047 [P] [US6] Add bounded web clipboard outcomes, safe generic feedback, and pane/socket generation cancellation in `shell/src/components/terminal/TerminalPane.tsx` and `shell/src/components/terminal/terminal-rich-paste.ts`
- [ ] T048 [US6] Run all User Story 6 tests in `tests/desktop/terminal-link-actions.test.ts`, `tests/desktop/terminal-view.test.tsx`, `tests/shell/terminal-rich-paste.test.ts`, `tests/shell/terminal-pane-clipboard.test.tsx`, and `tests/shell/terminal-pane-privacy.test.tsx`

**Checkpoint**: Clipboard failures are safe, private, retryable, and independently testable.

---

## Phase 9: End-to-End, CI, Documentation, and Review Readiness

**Purpose**: Prove the complete journeys with real xterm/Electron behavior and satisfy Matrix OS delivery gates.

- [ ] T049 Add a packaged Electron E2E journey using native `clipboard`, deterministic multiline/wrapped/Unicode output, inner-xterm right-click, 50 selection trials, SGR any-motion for at least ten seconds, multiple terminals, native Canvas/Desktop modes, and exactly-once Paste in `tests/e2e/desktop/terminal-clipboard.e2e.test.ts`
- [ ] T050 Update the post-desktop-build E2E invocation so `tests/e2e/desktop/terminal-clipboard.e2e.test.ts` cannot pass by skipping when build artifacts are absent in `.github/workflows/ci.yml`
- [ ] T051 Run the targeted suites and packaged Electron test from `specs/118-fix-terminal-clipboard/quickstart.md`, fixing only feature regressions and recording unrelated baseline failures
- [ ] T052 Run `npx react-doctor@latest desktop` and `npx react-doctor@latest shell`, resolving findings for changed React files listed in `specs/118-fix-terminal-clipboard/plan.md`
- [ ] T053 Run `bun run typecheck`, `bun run check:patterns`, `bun run test`, and the relevant coverage command from `package.json`; resolve all feature failures and verify changed pure/renderer logic meets the repository coverage target
- [ ] T054 Capture and attach a current screenshot plus short recording using synthetic output, showing multiline selection, Copy enabled, and passive motion stability, following `specs/118-fix-terminal-clipboard/quickstart.md`
- [ ] T055 Open a separate private documentation PR in `FinnaAI/matrix-os-site` updating the existing terminal page under `content/docs/` with shortcuts, right-click/Select All behavior, mouse-aware selection behavior, and renderer parity
- [ ] T056 Re-run every acceptance scenario and measurable outcome in `specs/118-fix-terminal-clipboard/spec.md`, mark all completed implementation tasks in `specs/118-fix-terminal-clipboard/tasks.md`, verify `git diff --check`, and freeze the review commit range

**Checkpoint**: Complete feature is review-ready only after CI is green, screenshot/recording evidence is attached, both React audits pass, the docs PR exists, and Greptile reports 5/5 for every code-stack layer.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: Starts immediately; T003 blocks creating or committing stack layers if Graphite is unavailable or unauthenticated.
- **Phase 2 (Foundation)**: Depends on Phase 1 and blocks every user story.
- **Phase 3 (US1)**: Depends on Foundation and provides the shortcut MVP.
- **Phase 4 (US2)**: Depends on Foundation; integrates with US1's copy executor but is independently verified through context-menu tests.
- **Phase 5 (US3)**: Depends on Foundation; may begin after US2 tests define secondary-click ordering and completes the P1 release gate.
- **Phase 6 (US4)**: Depends on US2's general context menu and US3's movement shield.
- **Phase 7 (US5)**: Depends on US1–US4 so the same completed journeys can be checked under transformed layouts.
- **Phase 8 (US6)**: Depends on US1's copy/paste executors and may otherwise proceed in parallel with US4–US5.
- **Phase 9 (Polish)**: Depends on all six desired stories.

### User Story Dependencies

```text
Foundation
├── US1 Shortcuts ───────────────┬── US6 Failure recovery
├── US2 Right-click ──┬── US4 Select All
│                     └── US3 Mouse stability
└───────────────────────────────┬── US5 Layout parity
US1 + US2 + US3 = P1 release gate
All stories -> E2E / CI / evidence / docs
```

- **US1 (P1)**: Independently validates keyboard copy/paste and pane focus after Foundation.
- **US2 (P1)**: Independently validates context-menu fidelity after Foundation; reuses the US1 copy executor when integrated.
- **US3 (P1)**: Independently validates mouse-aware stability after Foundation; shares the secondary-click capture path with US2.
- **US4 (P2)**: Independently validates Select All but requires the menu surface introduced by US2 and movement protection from US3.
- **US5 (P2)**: Independently validates completed journeys across native/web Canvas/Desktop and therefore follows US1–US4.
- **US6 (P3)**: Independently validates failures after US1 establishes clipboard executors; it can be developed alongside US4/US5 on non-overlapping helpers, but renderer-file edits must remain sequential.

### Within Each User Story

1. Add every listed story test and run it to observe the expected failure.
2. Implement only the behavior needed to make that story green.
3. Run the complete story checkpoint, including prior story regressions.
4. Refactor without changing the contract or leaking clipboard content.
5. Preserve the completed phase as its Graphite layer before editing the next layer.

---

## Parallel Opportunities

- T008–T012 can be authored in parallel because they own distinct native/web test files; implementations remain ordered by their helper dependencies.
- T018–T021 can be authored in parallel, followed by parallel native T022 and web T023 implementation.
- T025–T027 can be authored in parallel, followed by parallel native T028 and web T029 implementation.
- T031 and T032 can be authored in parallel, followed by parallel native T033 and web T034 implementation.
- T036–T039 can be authored in parallel; native T040 and web T041 can then proceed independently.
- T043 and T044 can be authored in parallel; complete sequential privacy assertions in T045, then native T046 and web T047 can proceed independently if no shared file has an unfinished edit.
- User Story 6 may run alongside User Stories 4–5 only when file ownership is separated; never edit `TerminalView.tsx` or `TerminalPane.tsx` concurrently.

## Parallel Example: User Story 2

```text
Task T018: Native inner-xterm context ordering tests in tests/desktop/terminal-view.test.tsx
Task T019: Native menu snapshot/focus tests in tests/desktop/terminal-link-context-menu.test.tsx
Task T020: Web menu snapshot/focus tests in tests/shell/terminal-link-context-menu.test.tsx
Task T021: Web inner-xterm context ordering tests in tests/shell/terminal-pane-clipboard.test.tsx
```

## Parallel Example: User Story 5

```text
Task T036: Native scale-forwarding tests in tests/desktop/native-desktop-shell.test.tsx and tests/desktop/terminals-tab.test.tsx
Task T037: Native transformed-pointer tests in tests/desktop/terminal-view.test.tsx
Task T038: Web zoom policy tests in tests/shell/terminal-pane-zoom-correction.test.ts
Task T039: Web Canvas lifecycle tests in tests/shell/canvas-window-terminal-overlay.test.tsx
```

---

## Graphite Stack Plan

This feature exceeds one small PR because it spans shared contracts, two xterm implementations, Canvas scale wiring, CI, E2E, and documentation. Preserve these layers; do not flatten them unless explicitly requested.

1. **Layer 1 — Shared policy and specification** (`feat(terminal): define clipboard interaction policy`): existing feature artifacts plus T001–T007.
2. **Layer 2 — Shortcut execution** (`fix(terminal): support reliable clipboard shortcuts`): T008–T017 / US1 across native and web renderers.
3. **Layer 3 — Selection preservation** (`fix(terminal): preserve selection during pointer actions`): T018–T030 / US2–US3.
4. **Layer 4 — Select All and layout parity** (`fix(terminal): align selection across canvas layouts`): T031–T042 / US4–US5.
5. **Layer 5 — Failure safety and verification** (`test(terminal): harden clipboard failure journeys`): T043–T054 and T056 / US6, Electron E2E, CI, audits, and evidence.
6. **Separate docs-repository PR** (`docs(terminal): document clipboard and selection behavior`): T055 in private `FinnaAI/matrix-os-site`; it is linked from the code stack but is not a Matrix OS Graphite layer.

At each Matrix OS layer checkpoint, use `gt create --all --message "<title>"` for a new upstack layer or `gt modify --all` for fixes to the current layer, then `gt restack` after lower-layer changes. Use `gt submit --stack` only when the user asks to publish. Keep each layer below 1,000 additions/20 files where practical and always below 3,000 additions/50 files.

---

## Implementation Strategy

### Shortcut MVP

1. Complete Setup and Foundation.
2. Complete US1.
3. Stop and validate Command+C, Command+Shift+C, Command+V, Ctrl+Shift compatibility, and pane isolation.

US1 is a demonstrable shortcut MVP, but it does not resolve every reported bug. The recommended first releasable slice is the complete P1 bundle: US1 + US2 + US3.

### Incremental Delivery

1. Foundation → deterministic shared policy.
2. US1 → reliable shortcuts.
3. US2 → trustworthy right-click Copy.
4. US3 → selection stability in Codex/mouse-aware TUIs (P1 release gate).
5. US4 → stable Select All.
6. US5 → native/web Canvas/Desktop zoom and pane parity.
7. US6 → safe failure and retry behavior.
8. E2E, CI, evidence, docs, and Greptile 5/5 → review-ready stack.

### Validation Discipline

- Do not mark a test task complete until its pre-implementation run fails for the intended missing behavior.
- Do not mark an implementation task complete until its focused tests pass.
- Do not record a full gate as passing when a test skipped due to a missing desktop build.
- Record unrelated baseline failures verbatim in the relevant PR body; do not weaken tests or hide failures.
- Commit or amend the corresponding Graphite layer after each phase checkpoint, as required by the Matrix OS constitution.
