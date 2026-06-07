# Tasks: macOS Developer Experience

**Input**: Design documents from `specs/088-macos-dev-experience/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: TDD is required by the spec and constitution. Test tasks appear before implementation tasks in each user-story phase.

**Organization**: Tasks are grouped by user story so terminal foundation, editor foundation, and workspace integration can ship independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files or has no dependency on incomplete tasks
- **[Story]**: User story label from `spec.md`
- Every task includes concrete repository paths

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the latest-main baseline and create spec-visible implementation scaffolding.

- [x] T001 Commit `specs/088-macos-dev-experience/` plan artifacts and update `.specify/feature.json`
- [x] T002 Merge latest `origin/main` into `088-macos-native-shell` and resolve conflicts by taking landed mainline macOS code
- [x] T003 [P] Review current terminal files in `macos/Sources/Terminal/` and tests in `macos/Tests/TerminalTests/` against US1 requirements
- [x] T004 [P] Review current editor files in `macos/Sources/App/SyntaxHighlightedCodeEditor.swift` and `shell/src/components/preview-window/CodeEditor.tsx` against US2 requirements

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Define engine boundaries before changing terminal or editor behavior.

**CRITICAL**: User-story implementation should not swap engines until these boundaries exist.

- [x] T005 [P] Add terminal renderer boundary tests in `macos/Tests/TerminalTests/TerminalRendererTests.swift`
- [x] T006 Add `TerminalRendererKind` and `TerminalRendererConfiguration` in `macos/Sources/Terminal/TerminalRenderer.swift`
- [x] T007 Wire SwiftTerm panel metadata to the terminal renderer boundary in `macos/Sources/Terminal/TerminalPanelView.swift`
- [x] T008 [P] Add editor engine boundary tests in `macos/Tests/AppTests/EditorEngineTests.swift`
- [x] T009 Add `EditorEngineKind` and `EditorEngineConfiguration` in `macos/Sources/App/EditorEngine.swift`
- [x] T010 Update `specs/088-macos-dev-experience/tasks.md` after each completed task

**Checkpoint**: Terminal and editor engine boundaries exist; implementation can proceed without changing engine behavior.

---

## Phase 3: User Story 1 - Work In A First-Class Terminal (Priority: P1) MVP

**Goal**: Preserve current SwiftTerm launch path while making terminal renderer identity, lifecycle, and future Ghostty migration explicit.

**Independent Test**: Open a project terminal, run an interactive command, switch tabs, relaunch, and verify the same session can be resumed without duplicated PTYs or raw errors.

### Tests for User Story 1

- [x] T011 [P] [US1] Add terminal renderer identity assertions in `macos/Tests/TerminalTests/TerminalRendererTests.swift`
- [ ] T012 [P] [US1] Add terminal detach-vs-shutdown lifecycle assertions in `macos/Tests/TerminalTests/TerminalSessionTests.swift`
- [ ] T013 [P] [US1] Add reconnect/replay renderer-safe assertions in `macos/Tests/TerminalTests/ShellWSClientTests.swift`

### Implementation for User Story 1

- [x] T014 [US1] Expose SwiftTerm renderer kind from `macos/Sources/Terminal/TerminalPanelView.swift`
- [x] T015 [US1] Add terminal renderer settings hooks for future Ghostty selection in `macos/Sources/Terminal/TerminalRenderer.swift`
- [ ] T016 [US1] Keep user-facing terminal errors generic while recording renderer kind in diagnostics in `macos/Sources/Terminal/TerminalSession.swift`
- [ ] T017 [US1] Document Ghostty/libghostty spike gates in `specs/088-macos-dev-experience/quickstart.md`
- [ ] T018 [US1] Run `swift test --package-path macos --filter TerminalTests`

**Checkpoint**: US1 MVP is independently testable and still uses SwiftTerm.

---

## Phase 4: User Story 2 - Edit Code With VS Code-Class Expectations (Priority: P2)

**Goal**: Preserve current native/CodeMirror editor paths while introducing an editor engine boundary for Monaco.

**Independent Test**: Open several project files, edit/save safely, and verify engine metadata distinguishes native TextKit, CodeMirror, and planned Monaco surfaces.

### Tests for User Story 2

- [ ] T019 [P] [US2] Add editor engine identity tests in `macos/Tests/AppTests/EditorEngineTests.swift`
- [ ] T020 [P] [US2] Add editor dirty/conflict state tests in `macos/Tests/AppTests/EditorDocumentStateTests.swift`
- [ ] T021 [P] [US2] Add gateway file-save contract tests for revision-aware saves in `tests/gateway/file-blob-routes.test.ts`

### Implementation for User Story 2

- [ ] T022 [US2] Add `EditorDocumentState` in `macos/Sources/App/EditorDocumentState.swift`
- [ ] T023 [US2] Wire `SyntaxHighlightedCodeEditor` to native TextKit engine metadata in `macos/Sources/App/SyntaxHighlightedCodeEditor.swift`
- [ ] T024 [US2] Add Monaco WKWebView spike notes and feature-flag contract in `specs/088-macos-dev-experience/research.md`
- [ ] T025 [US2] Harden gateway file content save contract with revision checks and generic errors in `packages/gateway/src/file-blob-routes.ts`
- [ ] T026 [US2] Run `swift test --package-path macos --filter AppTests` and `pnpm test tests/gateway/file-blob-routes.test.ts`

**Checkpoint**: US2 editor foundation is independently testable without replacing the current editor.

---

## Phase 5: User Story 3 - Use One Coding Workspace, Not Separate Tools (Priority: P3)

**Goal**: Coordinate terminal/editor/file/agent commands in one native workspace with recoverable layout references.

**Independent Test**: Open a task workspace, arrange terminal and editor panes, invoke command palette file/terminal actions, relaunch, and verify useful state restoration.

### Tests for User Story 3

- [ ] T027 [P] [US3] Add workspace command registry tests in `macos/Tests/AppTests/WorkspaceCommandTests.swift`
- [ ] T028 [P] [US3] Add workspace layout recovery tests in `macos/Tests/AppTests/AppModelWorkspaceRestoreTests.swift`

### Implementation for User Story 3

- [ ] T029 [US3] Add workspace command model in `macos/Sources/App/WorkspaceCommand.swift`
- [ ] T030 [US3] Wire command palette entries for opening files and focusing terminals in `macos/Sources/App/CommandPalette.swift`
- [ ] T031 [US3] Add recoverable workspace layout references in `macos/Sources/App/AppModel.swift`
- [ ] T032 [US3] Add stale terminal/file reference states in `macos/Sources/App/EmptyStates.swift`
- [ ] T033 [US3] Run `swift test --package-path macos --filter AppTests`

**Checkpoint**: Workspace commands and layout recovery work independently of Monaco/Ghostty swaps.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, validation, and follow-up gates.

- [ ] T034 [P] Update public docs for native developer workspace direction in `www/content/docs/guide/cloud-coding.mdx`
- [ ] T035 [P] Update developer workflow docs with CodeMirror-vs-Monaco decision in `www/content/docs/guide/developer-workflow.mdx`
- [ ] T036 Run `swift test --package-path macos`
- [ ] T037 Run `bun run typecheck`
- [ ] T038 Run `bun run check:patterns`
- [ ] T039 Run `bun run test`
- [ ] T040 If React files changed, run `npx react-doctor@latest shell`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 and T002 are complete; T003/T004 can run immediately.
- **Foundational (Phase 2)**: Depends on Setup review; blocks engine-specific work.
- **US1 Terminal MVP (Phase 3)**: Depends on T005-T007.
- **US2 Editor Foundation (Phase 4)**: Depends on T008-T009; may run after US1 or in parallel once foundations exist.
- **US3 Workspace Integration (Phase 5)**: Depends on at least one terminal/editor foundation path and should follow US1/US2 for clean review.
- **Polish (Phase 6)**: Depends on selected user-story phases.

### Graphite Stack Plan

- **Stack 1**: `docs(macos): spec developer workspace experience` plus `tasks.md`.
- **Stack 2**: Terminal/editor boundary scaffolding in `macos/`.
- **Stack 3**: US1 terminal foundation and Ghostty spike gates.
- **Stack 4**: US2 editor foundation and Monaco decision surface.
- **Stack 5**: US3 workspace command/layout integration.
- **Final Stack**: Public docs and full validation.

Each stack layer should remain under Matrix OS PR size limits and follow `docs/dev/stacked-prs.md`. Do not flatten the stack unless explicitly requested.

### Parallel Opportunities

- T003 and T004 can run in parallel.
- T005 and T008 can run in parallel.
- T011, T012, and T013 can run in parallel after T005-T007.
- T019, T020, and T021 can run in parallel after T008-T009.
- T034 and T035 can run in parallel after implementation decisions are stable.

## Implementation Strategy

### MVP First

1. Finish T003, T005, T006, and T007.
2. Complete US1 tasks T011-T018.
3. Validate with terminal-focused Swift tests.

### Incremental Delivery

1. Terminal boundary and SwiftTerm preservation.
2. Editor boundary and Monaco planning surface.
3. Workspace command/layout integration.
4. Public docs and full repo validation.

## Notes

- CodeMirror is not removed. It remains a lightweight preview/editing engine.
- Monaco is the planned VS Code-class editor engine and should be spiked behind a feature flag before becoming default.
- Ghostty/libghostty is not a direct replacement until build, lifecycle, rendering, resize, input, packaging, and licensing gates pass.
