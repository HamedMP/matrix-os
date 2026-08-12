# Files List Action Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the Desktop Files list `More actions` button from overlapping the `Modified` value while preserving grid behavior and accessibility.

**Architecture:** Extend the existing shared list grid template with a fixed 32 px action column, then give the action button explicit hover, focus, and selected visibility states. Keep all operation/controller behavior unchanged.

**Tech Stack:** React 19, TypeScript strict mode, Tailwind utility classes, Radix Dropdown Menu, Vitest, React Testing Library.

## Global Constraints

- Use the existing Desktop Files components; add no dependency.
- Preserve accessible button names, keyboard focus, context menus, and disabled behavior.
- List view must use the same four-column template for header and rows.
- Grid view must keep its existing top-right action placement.
- Focused production and test files must remain below 500 lines.

---

### Task 1: Lock the list action-column contract

**Files:**
- Test: `tests/desktop/files-actions-layout.test.tsx`
- Modify: `desktop/src/renderer/src/features/files/browser-views.tsx`
- Modify: `desktop/src/renderer/src/features/files/ComputerFileBrowser.tsx`

**Interfaces:**
- Consumes: `ComputerFileBrowser` public rendered UI and `EntryButton` list layout.
- Produces: one four-column `listColumns` string used by list header and rows.

- [ ] **Step 1: Write the failing rendered test**

Render Files in list mode and assert that the list header and the `Open note.md`
row both expose a fourth 32 px action track after `Modified`.

- [ ] **Step 2: Run the test to verify RED**

Run: `flox activate -- pnpm exec vitest run tests/desktop/files-actions-layout.test.tsx`

Expected: FAIL because the current template has only name, size, and modified tracks.

- [ ] **Step 3: Implement the action track**

Change the compact template to `minmax(0,1fr) 64px 88px 32px` and the regular
template to `minmax(0,1fr) 72px 104px 32px`. Add one inert final cell to both
the header and list entry grid.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `flox activate -- pnpm exec vitest run tests/desktop/files-actions-layout.test.tsx`

Expected: PASS.

### Task 2: Add quiet but accessible action visibility

**Files:**
- Test: `tests/desktop/files-actions-layout.test.tsx`
- Modify: `desktop/src/renderer/src/features/files/FileActionMenu.tsx`
- Modify: `desktop/src/renderer/src/features/files/ComputerFileBrowser.tsx`

**Interfaces:**
- Consumes: current entry selection from `useFileManagement`.
- Produces: `selected: boolean` on `ManagedFileActionMenu` and `FileActionMenu`.

- [ ] **Step 1: Write the failing visibility test**

Assert that an unselected action button is visually quiet, and that the class
contract includes hover and focus-within reveal states. Select the row and
assert its action button becomes fully visible without losing its accessible
name or focusability.

- [ ] **Step 2: Run the test to verify RED**

Run: `flox activate -- pnpm exec vitest run tests/desktop/files-actions-layout.test.tsx`

Expected: FAIL because the current button is always `opacity-70` and has no selected state.

- [ ] **Step 3: Implement the visibility contract**

Forward the row's selected boolean through `ManagedFileActionMenu` to
`FileActionMenu`. Use `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`
for inactive rows and `opacity-100` for selected rows; retain focus and pointer handlers.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `flox activate -- pnpm exec vitest run tests/desktop/files-actions-layout.test.tsx`

Expected: PASS.

### Task 3: Verify the Desktop Files surface

**Files:**
- Verify only: Desktop Files production/tests changed by Tasks 1–2.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: fresh evidence for the UI-layer stacked PR.

- [ ] **Step 1: Run focused regressions**

Run the new layout test plus `files-browser-views`, `files-management-ui`,
`files-management-concurrency`, `files-workspace`, and `file-selection` suites.

- [ ] **Step 2: Run Desktop typecheck and React Doctor**

Run the repository's Desktop TypeScript command and changed-scope React Doctor.

- [ ] **Step 3: Run pattern, whitespace, and LOC gates**

Require zero new pattern violations, `git diff --check` success, and every
focused production/test file below 500 lines.

- [ ] **Step 4: Commit the verified change**

Create a Conventional Commit on `codex/mat-268-desktop-files-ui`, then propagate
the new commit through the remaining stacked Desktop move/drag PR without merge.
