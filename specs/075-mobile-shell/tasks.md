# Tasks: Mobile Shell

**Input**: Design documents from `specs/075-mobile-shell/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/mobile-shell-api.md](./contracts/mobile-shell-api.md), [quickstart.md](./quickstart.md)

**Tests**: Required. The Matrix OS constitution and this feature plan require TDD, so each implementation phase includes failing tests before implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and validation.

## Current Status Snapshot (2026-05-14)

**Done**

- Phase 1 setup and PR #99 baseline cleanup are complete.
- Phase 2 foundational app/runtime state, gateway-client hardening, and app session-token contract work are complete.
- Phase 3 browser/native launcher-first app flow is complete for the implemented surfaces.
- Browser shell live-preview hardening is complete for app launch paths, shipped icon URLs, shell/gateway proxying, hydration-safe mobile detection, and browser terminal rendering/focus.
- Native mobile terminal client, state reducer, route, launcher entry, session picker, command row, touch control bar, screen-level regression coverage, and Expo SDK 54 package alignment are complete.
- Gateway terminal session list/delete validation, delete body limits, idempotent stale-session cleanup, and mobile WebSocket attach/input/resize/detach/destroy protocol coverage are complete.
- Explicit native/browser mobile resume choices are complete for app and terminal recovery.
- Explicit browser Canvas entry, mobile Canvas return-home wrapping, stale pan/zoom reset, and native Canvas unavailable-state entry are complete.
- Public and developer mobile-shell docs are complete.
- Focused 075 validation gates are green for full native mobile Jest, browser mobile shell/Canvas tests, gateway terminal contract tests, shell/mobile/root TypeScript, pattern scan, and diff whitespace.

**Not Done**

- Full root `bun run test` is last recorded as not green; current failures are outside the focused 075 path and are listed in `quickstart.md`.

## Phase 1: Setup (Shared Baseline)

**Purpose**: Establish a trustworthy branch baseline and task scaffolding before feature work.

- [x] T001 Reproduce PR #99 failing CI shards locally or in CI and record exact failures in `specs/075-mobile-shell/quickstart.md`
- [x] T002 Fix duplicate-session request assertion failure in `tests/shell/workspace-app.test.tsx`
- [x] T003 Fix generated Symphony source invariant failure in `tests/shell/symphony-app-source.test.ts`
- [x] T004 Run focused baseline tests `tests/shell/workspace-app.test.tsx` and `tests/shell/symphony-app-source.test.ts` and record command/result in `specs/075-mobile-shell/quickstart.md`
- [x] T005 [P] Add mobile shell test fixture helpers for phone-sized viewports in `tests/shell/mobile-shell-test-utils.tsx`
- [x] T006 [P] Add mobile Expo test fixture helpers for gateway/app runtime responses in `apps/mobile/__tests__/mobile-shell-test-utils.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared contracts, hardening, and state primitives that must be ready before user story implementation.

**CRITICAL**: No user story implementation should begin until this phase is complete.

- [x] T007 [P] Add failing tests for mobile gateway fetch timeout and safe-error behavior in `apps/mobile/__tests__/gateway-client.test.ts`
- [x] T008 Harden mobile gateway fetch helpers with timeout support and generic client errors in `apps/mobile/lib/gateway-client.ts`
- [x] T009 [P] Add failing tests for app slug/runtime route normalization edge cases in `apps/mobile/__tests__/apps.test.ts`
- [x] T010 Tighten app slug/runtime route helpers for mobile shell use in `apps/mobile/lib/apps.ts`
- [x] T011 [P] Add failing tests for mobile shell state validation in `apps/mobile/__tests__/mobile-shell-state.test.ts`
- [x] T012 Implement native mobile shell state parser and persistence adapter in `apps/mobile/lib/mobile-shell-state.ts`
- [x] T013 [P] Add failing tests for browser mobile shell state validation in `tests/shell/mobile-shell-state.test.ts`
- [x] T014 Implement browser mobile shell state parser and persistence helper in `shell/src/stores/mobile-shell-store.ts`
- [x] T015 [P] Add failing contract tests for mobile app session-token response shape in `tests/gateway/app-runtime-phase1.test.ts`
- [x] T016 Verify app session-token response and safe error behavior against the 075 contract in `packages/gateway/src/server.ts`

**Checkpoint**: Foundation ready; user stories can now be implemented independently.

---

## Phase 3: User Story 1 - Launch Apps From Mobile Home (Priority: P1) MVP

**Goal**: Phone-sized users land on a launcher, open apps full-screen, and return home without navigating Canvas.

**Independent Test**: Sign in on a phone-sized browser viewport and in the native mobile app; verify launcher is first usable surface, app opens full-screen, and Home returns to launcher with recoverable state.

### Tests for User Story 1

- [x] T017 [P] [US1] Add failing browser-shell test for launcher-first phone viewport in `tests/shell/mobile-shell.test.tsx`
- [x] T018 [P] [US1] Add failing browser-shell test for app open and return-home behavior in `tests/shell/mobile-shell.test.tsx`
- [x] T019 [P] [US1] Add failing native mobile launcher test for full-screen runtime navigation in `apps/mobile/__tests__/apps.test.ts`
- [x] T020 [P] [US1] Add failing safe unavailable-app fallback test in `apps/mobile/__tests__/apps.test.ts`

### Implementation for User Story 1

- [x] T021 [US1] Implement phone viewport detection hook in `shell/src/hooks/useMobileViewport.ts`
- [x] T022 [US1] Implement browser mobile launcher surface in `shell/src/components/mobile/MobileLauncher.tsx`
- [x] T023 [US1] Wire browser launcher-first mode into `shell/src/components/Desktop.tsx`
- [x] T024 [US1] Implement browser full-screen mobile app surface in `shell/src/components/mobile/MobileAppSurface.tsx`
- [x] T025 [US1] Wire return-home behavior from mobile app surfaces in `shell/src/components/AppViewer.tsx`
- [x] T026 [US1] Update native mobile app tab/index routing so Apps is the default launcher in `apps/mobile/app/index.tsx`
- [x] T027 [US1] Update native runtime fallback and return-home handling in `apps/mobile/app/runtime/[...slug].tsx`
- [x] T028 [US1] Update launcher card open-state and recovery indicators in `apps/mobile/app/(tabs)/apps.tsx`

**Checkpoint**: User Story 1 is independently functional and is the MVP.

---

## Phase 4: User Story 2 - Use Terminal Without SSH Keys (Priority: P1)

**Goal**: Mobile users open Terminal from Matrix, create/resume/detach/end terminal sessions through authenticated Matrix state, and use common terminal keys without SSH keys.

**Independent Test**: Open Terminal from the mobile launcher, run a command, detach/reload/resume the same session, send special keys, and intentionally end the session without using SSH credentials.

### Tests for User Story 2

- [x] T029 [P] [US2] Add failing gateway tests for terminal list/delete body limits and UUID validation in `tests/gateway/terminal-ws.test.ts`
- [x] T030 [P] [US2] Add failing WebSocket protocol tests for mobile attach/input/resize/detach/destroy flows in `tests/gateway/terminal-ws.test.ts`
- [x] T031 [P] [US2] Add failing native mobile terminal client tests in `apps/mobile/__tests__/terminal-client.test.ts`
- [x] T032 [P] [US2] Add failing native mobile terminal UI tests in `apps/mobile/__tests__/terminal-screen.test.tsx`
- [x] T033 [P] [US2] Add browser mobile terminal UI regression coverage in `tests/shell/terminal-app-component.test.tsx`

### Implementation for User Story 2

- [x] T034 [US2] Add bodyLimit and safe error handling to terminal session delete route in `packages/gateway/src/server.ts`
- [x] T035 [US2] Ensure terminal WebSocket attach/input/resize/detach/destroy behavior matches mobile contract in `packages/gateway/src/server.ts`
- [x] T036 [US2] Implement native mobile terminal gateway client in `apps/mobile/lib/terminal-client.ts`
- [x] T037 [US2] Implement native mobile terminal state reducer in `apps/mobile/lib/terminal-state.ts`
- [x] T038 [US2] Implement native mobile terminal screen and session picker in `apps/mobile/app/terminal/index.tsx`
- [x] T039 [US2] Implement native terminal control bar for Escape Tab arrows Control paste session switching and font sizing in `apps/mobile/components/TerminalControlBar.tsx`
- [x] T040 [US2] Add Terminal launcher entry and route mapping in `apps/mobile/lib/apps.ts`
- [x] T041 [US2] Implement browser mobile terminal surface via `TerminalApp mobile` in `shell/src/components/terminal/TerminalApp.tsx`
- [x] T042 [US2] Wire Terminal launcher entry and full-screen route through `shell/src/components/Desktop.tsx` and `shell/src/components/mobile/MobileLauncher.tsx`

### Browser Shell Terminal Hardening Completed During Live Preview

- [x] T070 [US2] Add visible mobile/desktop terminal cwd strip and cursor fallback in `shell/src/components/terminal/TerminalPane.tsx`
- [x] T071 [US2] Disable WebGL terminal renderer fallback path and force xterm element sizing in `shell/src/components/terminal/TerminalPane.tsx`
- [x] T072 [US2] Focus xterm on pointer/touch down in `shell/src/components/terminal/TerminalPane.tsx`
- [x] T073 [US2] Make stale terminal-session DELETE idempotent for explicit close cleanup in `packages/gateway/src/server.ts`
- [x] T074 [US2] Verify live terminal WebSocket prompt output through `127.0.0.1:4121/ws/terminal?cwd=projects`

**Checkpoint**: Browser-shell terminal and native mobile terminal are functional for the no-SSH path, with gateway protocol regression tests and native screen-level UI coverage in place.

---

## Phase 5: User Story 3 - Resume Recent Mobile Work (Priority: P2)

**Goal**: Mobile users can return to recent apps and terminal sessions after interruption without losing recoverable state.

**Independent Test**: Open an app and terminal, background/reload Matrix, return later, and verify Matrix offers the last app plus terminal resume choices with safe fallback for missing resources.

### Tests for User Story 3

- [x] T043 [P] [US3] Add failing native mobile last-active app resume tests in `apps/mobile/__tests__/mobile-shell-state.test.ts`
- [x] T044 [P] [US3] Add browser mobile shell state validation tests in `tests/shell/mobile-shell-state.test.ts`
- [x] T045 [P] [US3] Add failing terminal resume choice tests in `apps/mobile/__tests__/terminal-screen.test.tsx`
- [x] T046 [P] [US3] Add browser mobile launcher/home recovery regression tests in `tests/shell/mobile-shell.test.tsx`

### Implementation for User Story 3

- [x] T047 [US3] Persist and validate native last-active app state in `apps/mobile/lib/mobile-shell-state.ts`
- [x] T048 [US3] Persist and validate browser last-active app state in `shell/src/stores/mobile-shell-store.ts`
- [x] T049 [US3] Add resume choices to native launcher and terminal screens in `apps/mobile/app/(tabs)/apps.tsx`
- [x] T050 [US3] Add resume choices to browser mobile launcher in `shell/src/components/mobile/MobileLauncher.tsx`
- [x] T051 [US3] Handle missing restored apps with safe fallback in `shell/src/components/mobile/MobileAppSurface.tsx`
- [x] T052 [US3] Handle exited/missing terminal sessions with safe recovery in `apps/mobile/app/terminal/index.tsx`

### Browser Shell Resume Hardening Completed During Live Preview

- [x] T075 [US3] Reset browser mobile hard-refresh/onboarding completion to launcher mode in `shell/src/components/Desktop.tsx`
- [x] T076 [US3] Prevent SSR/client mobile viewport mismatch by deferring phone detection until mount in `shell/src/hooks/useMobileViewport.ts`
- [x] T077 [US3] Prevent Clerk user-button hydration mismatch in `shell/src/components/UserButton.tsx` and `shell/src/components/MenuBar.tsx`

**Checkpoint**: Browser and native resume choices are functional for recent apps and terminal sessions, with safe fallbacks for missing resources.

---

## Phase 6: User Story 4 - Access Canvas When It Helps (Priority: P3)

**Goal**: Canvas remains explicitly reachable on mobile, but never becomes the default phone home or traps users in panned/zoomed state.

**Independent Test**: Switch from launcher to Canvas on a phone-sized viewport, then return to launcher without losing open app records.

### Tests for User Story 4

- [x] T053 [P] [US4] Add failing browser mobile Canvas entry/return tests in `tests/shell/mobile-canvas.test.tsx`
- [x] T054 [P] [US4] Add failing Canvas no-trap regression test for phone viewport in `tests/shell/mobile-canvas.test.tsx`
- [x] T055 [P] [US4] Add failing native mobile Canvas entry unavailable-state test in `apps/mobile/__tests__/canvas-entry.test.tsx`

### Implementation for User Story 4

- [x] T056 [US4] Add explicit Canvas launcher action in `shell/src/components/mobile/MobileLauncher.tsx`
- [x] T057 [US4] Add mobile return-to-launcher control around Canvas in `shell/src/components/Desktop.tsx` and `shell/src/components/mobile/MobileAppSurface.tsx`
- [x] T058 [US4] Gate mobile Canvas pan/zoom restore so stale state cannot trap phone users in `shell/src/hooks/useCanvasTransform.ts`
- [x] T059 [US4] Add native mobile Canvas entry or unavailable-state screen in `apps/mobile/app/canvas/index.tsx`
- [x] T060 [US4] Add Canvas entry route mapping in `apps/mobile/lib/apps.ts`

**Checkpoint**: User Story 4 is independently functional and Canvas remains explicit on mobile.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final hardening, docs, and verification across all user stories.

- [x] T061 [P] Update mobile shell public docs in `www/content/docs/`
- [x] T062 [P] Update developer notes for mobile shell and terminal validation in `docs/dev/mobile-shell.md`
- [x] T063 [P] Add or update quickstart validation results in `specs/075-mobile-shell/quickstart.md`
- [x] T064 Run focused native mobile tests and record command coverage in `specs/075-mobile-shell/quickstart.md`
- [x] T065 Run focused gateway terminal/app-runtime tests and record command coverage in `specs/075-mobile-shell/quickstart.md`
- [x] T066 Run focused browser shell tests and record command coverage in `specs/075-mobile-shell/quickstart.md`
- [x] T067 Run `bun run check:patterns` resolve violations in scanner-listed files and record result in `specs/075-mobile-shell/quickstart.md`
- [x] T068 Run `bun run typecheck` resolve type errors in changed files and record result in `specs/075-mobile-shell/quickstart.md`
- [x] T069 Run `bun run test` and resolve regressions or document environment blockers in `specs/075-mobile-shell/quickstart.md`

### Live Preview Hardening Completed

- [x] T078 Canonicalize runtime app launch paths and stale nested app paths in `shell/src/lib/app-launch.ts`, `shell/src/components/Desktop.tsx`, and `shell/src/components/AppViewer.tsx`
- [x] T079 Fix shipped SVG icon URLs for built-ins so browser shell stops requesting missing `.png` files
- [x] T080 Add shell dev rewrites/proxy coverage for `/api`, `/apps`, `/files`, `/icons`, and WebSocket paths in `shell/next.config.ts` and `shell/proxy.ts`
- [x] T081 Verify Backgammon runtime route serves built `assets/...` HTML after app session minting
- [x] T082 Verify live terminal session cap behavior and clear detached preview sessions before live terminal smoke testing
- [x] T083 Align Expo mobile package manifest and root lockfile back to Expo SDK 54 / React Native 0.81 / React 19.1 in `apps/mobile/package.json` and `pnpm-lock.yaml`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies; start immediately.
- **Phase 2 Foundational**: Depends on Phase 1; blocks all user stories.
- **Phase 3 US1**: Depends on Phase 2; MVP.
- **Phase 4 US2**: Depends on Phase 2; can run in parallel with US1 if files are coordinated.
- **Phase 5 US3**: Depends on US1 and US2 because it resumes app and terminal state.
- **Phase 6 US4**: Depends on Phase 2 and can run after or alongside US1 if launcher file ownership is coordinated.
- **Phase 7 Polish**: Depends on desired user stories being complete.

### User Story Dependencies

- **US1 Launch Apps From Mobile Home**: MVP; no dependency on other stories after foundation.
- **US2 Use Terminal Without SSH Keys**: No dependency on US1 after foundation, except launcher entry integration should coordinate with US1 edits.
- **US3 Resume Recent Mobile Work**: Depends on US1 app surfaces and US2 terminal state.
- **US4 Access Canvas When It Helps**: Depends on shared launcher shell state from foundation; no dependency on US2.

### Within Each User Story

- Tests must be written first and fail before implementation.
- State/model helpers before UI wiring.
- Gateway contract changes before client calls that depend on them.
- Core surface behavior before recovery and empty states.
- Validate each story at its checkpoint before moving to the next priority.

---

## Parallel Opportunities

- T005 and T006 can run in parallel.
- T007, T009, T011, T013, and T015 can run in parallel because they touch separate test files.
- US1 tests T017-T020 can run in parallel.
- US2 tests T029-T033 can run in parallel.
- US3 tests T043-T046 can run in parallel.
- US4 tests T053-T055 can run in parallel.
- Documentation tasks T061-T063 can run in parallel after implementation.

## Parallel Example: User Story 1

```bash
Task: "T017 [P] [US1] Add failing browser-shell test for launcher-first phone viewport in tests/shell/mobile-shell.test.tsx"
Task: "T019 [P] [US1] Add failing native mobile launcher test for full-screen runtime navigation in apps/mobile/__tests__/apps.test.ts"
Task: "T020 [P] [US1] Add failing safe unavailable-app fallback test in apps/mobile/__tests__/apps.test.ts"
```

## Parallel Example: User Story 2

```bash
Task: "T029 [P] [US2] Add failing gateway tests for terminal list/delete body limits and UUID validation in tests/gateway/terminal-ws.test.ts"
Task: "T031 [P] [US2] Add failing native mobile terminal client tests in apps/mobile/__tests__/terminal-client.test.ts"
Task: "T033 [P] [US2] Add failing browser mobile terminal UI tests in tests/shell/mobile-terminal.test.tsx"
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 (US1).
3. Stop and validate the phone launcher/app-open/home flow in browser shell and native mobile.
4. Demo or review MVP before adding terminal complexity.

### Incremental Delivery

1. Setup + Foundation -> trustworthy baseline and shared state/contracts.
2. US1 -> launcher-first app opening.
3. US2 -> first-party no-SSH terminal.
4. US3 -> resume interrupted mobile work.
5. US4 -> explicit Canvas access.
6. Polish -> docs and full review gates.

### Review Strategy

- Keep PR #99 CI cleanup separate from new mobile behavior in commit history if possible.
- Avoid pushing while review is in progress unless declaring a new review commit range.
- Before review, include backend invariants for terminal/app-runtime changes: source of truth, transaction/lock scope, acceptable orphan states, auth source of truth, and deferred scope.

## Notes

- [P] tasks use different files or are test-only setup that can be done independently.
- Story labels map to `spec.md` user stories.
- Use existing gateway terminal protocol unless a task explicitly proves a new endpoint is necessary.
- Do not introduce Docker as a production customer runtime path.
