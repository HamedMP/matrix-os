# Tasks: Project sidebar actions

## Phase 1: Setup
- [x] T001 Create issue #1770 and spec/checklist in specs/526-project-sidebar-actions.
- [x] T002 Research persistence, native capability and shared navigation; write plan/contracts.

## Phase 2: Foundation
- [x] T003 Add failing gateway persistence/auth/validation tests in tests/gateway/project-metadata.test.ts.
- [x] T004 Implement project-metadata.ts and route registration; add pinned to registry/manager types.

## Phase 3: US1 Safe project menus
- [x] T005 [US1] Add failing menu-access regression tests in tests/desktop/project-sidebar-actions.test.tsx.
- [x] T006 [US1] Implement shared action descriptors and ellipsis/context menus in work-rail/WorkRailProjectGroup.tsx; preserve deletion confirmation.

## Phase 4: US2 Pin and Edit
- [x] T007 [US2] Add failing client mutation/sort/edit tests in tests/desktop/project-sidebar-actions.test.tsx.
- [x] T008 [US2] Implement runtime-safe metadata action hook, edit dialog and stable pin sorting; update board projection.

## Phase 5: US3 Locate files
- [x] T009 [US3] Test project-scoped file navigation and implement Files dialog using InspectorFilesPanel.

## Phase 6: Validation and delivery
- [x] T010 Run relevant regression suites, scoped typechecks and diff review; record results in quickstart.md.
- [x] T011 Open implementation PR and separate public docs PR in FinnaAI/matrix-os-site.

## Dependencies and execution
T001–T004 precede mutation UI; T005 precedes T006; T007 precedes T008; T009 reuses menus. T010/T011 follow all stories. Tests and implementation are sequential per story; research was delegated independently. No parallel writers required.

## Graphite Stack Plan
Two reviewable layers: spec/backend foundation, then shared UI/tests; keep each below 1000 additions and 20 files. Public docs are a separate repository PR. Commit each phase; submit via Graphite once validated. Do not merge before Human Review.

## Delivery

- Backend/spec: https://github.com/HamedMP/matrix-os/pull/1771
- Electron UI: https://github.com/HamedMP/matrix-os/pull/1772
- Public docs: https://github.com/FinnaAI/matrix-os-site/pull/118
- All PRs are drafts. Human Review, live runtime acceptance, CI/Greptile and landing remain pending.
