# Desktop Project Lifecycle Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task by task, and `superpowers:test-driven-development` for every behavior change.

**Goal:** Add safe archive, restore, and permanent-delete controls for Electron Desktop projects while preserving external folder contents and reconciling all renderer state only after Gateway success.

**Architecture:** A headless Gateway lifecycle service owns validation, owner scoping, active-work checks, durable project state, and cleanup. HTTP and CLI are thin adapters. Electron consumes active and archived projections through a focused lifecycle store, while sidebar and Settings components only render actions and confirmation state.

**Validated UX correction:** Archive runs immediately from the sidebar because it is reversible. Permanent delete alone uses typed confirmation. Renderer menus/dialogs hold a transient overlay lease that detaches Home's native `WebContentsView`, and mixed-version 404s without a Gateway error code show an update-required message.

**Tech Stack:** TypeScript 5.5+ strict ESM, Hono, Zod 4, Node `fs/promises`, React 19, Zustand, Radix UI, Vitest, Testing Library, Electron Vite.

---

## Delivery shape

This plan is one vertical feature with two reviewable implementation commits after the existing approved-spec commit:

1. Gateway lifecycle contract, persistence, CLI compatibility, and tests.
2. Electron lifecycle state, sidebar/Settings UX, end-to-end fixture coverage, and verification.

The public documentation update is a separate PR in `FinnaAI/matrix-os-site`; do not create it until repository authorization is explicitly confirmed.

## Task 1: Canonical project lifecycle state

**Files:**

- Modify: `packages/gateway/src/project-manager.ts`
- Modify: `tests/gateway/project-manager.test.ts`

- [ ] Add failing tests proving that active listings exclude archived/deleting projects, archived listings contain only archived projects, and legacy records receive a stable `kind` classification.
- [ ] Run `flox activate -- bun run test -- tests/gateway/project-manager.test.ts` and confirm the new assertions fail because lifecycle fields/projections do not exist.
- [ ] Extend `ProjectConfig` with `kind`, `archivedAt`, and `deletingAt`; add a `ProjectVisibility` union and owner-scoped `listManagedProjects({ visibility })` projection.
- [ ] Persist `kind` at each create seam (`scratch`, `github`, `folder`). For legacy configs, classify from validated config data and atomically rewrite before lifecycle mutation.
- [ ] Add project-manager primitives used by the lifecycle service:

```ts
getProjectForLifecycle(slug: string, ownerScope: string): Promise<ProjectConfig>
setProjectLifecycleState(
  slug: string,
  ownerScope: string,
  patch: Pick<ProjectConfig, "archivedAt" | "deletingAt">,
): Promise<ProjectConfig>
removeManagedProject(slug: string, ownerScope: string): Promise<void>
```

- [ ] Ensure `removeManagedProject` deletes the Matrix registry directory only. A folder project's external `localPath` must never be passed to `rm`.
- [ ] Re-run the focused test until green, then run `git diff --check`.

## Task 2: Project-related state and active-work boundaries

**Files:**

- Modify: `packages/gateway/src/coding-agents/thread-store.ts`
- Modify: `packages/gateway/src/agent-session-manager.ts`
- Modify: `packages/gateway/src/review-store.ts`
- Modify: `tests/gateway/coding-agent-thread-store.test.ts` (use the existing exact filename discovered with `rg --files`)
- Modify: the existing agent-session and review-store test files discovered with `rg --files tests/gateway`

- [ ] Add failing store-level tests for listing project lifecycle blockers and deleting all inactive project-owned thread/session/review records without touching another project or owner.
- [ ] Confirm RED with the smallest focused Vitest commands.
- [ ] Add explicit owner-scoped query/cleanup methods; do not expose raw filesystem paths or provider errors.
- [ ] Treat starting/running/idle/waiting agent sessions and nonterminal coding-agent turns as blockers. Reviews may be removed only after active review work is absent.
- [ ] Keep the store state serializable and atomically persisted using its existing mutation helper.
- [ ] Re-run each focused suite to GREEN, then run the combined related-store suites.

## Task 3: Deep Gateway lifecycle service

**Files:**

- Create: `packages/gateway/src/project-lifecycle.ts`
- Create: `tests/gateway/project-lifecycle.test.ts`
- Modify: `packages/gateway/src/workspace-routes.ts`
- Modify: `packages/gateway/src/server.ts`
- Modify: `tests/gateway/workspace-routes.test.ts`

- [ ] Write service tests first for these literal outcomes:
  - archive sets `archivedAt` and preserves project data;
  - restore clears `archivedAt` and is idempotent;
  - delete rejects a mismatched typed confirmation;
  - active work rejects archive/delete without changing state;
  - managed project deletion removes Matrix state;
  - folder project deletion leaves a sentinel file in the external directory byte-for-byte unchanged;
  - a failure after `deletingAt` leaves the tombstone hidden and a retry completes cleanup;
  - owner A cannot act on owner B's project.
- [ ] Run `flox activate -- bun run test -- tests/gateway/project-lifecycle.test.ts` and confirm RED because the module is absent.
- [ ] Implement the narrow public contract:

```ts
type ProjectLifecycleAction =
  | { type: "archive" }
  | { type: "restore" }
  | { type: "delete"; confirmation: string };

applyProjectLifecycleAction(
  principal: RequestPrincipal,
  projectSlug: string,
  action: ProjectLifecycleAction,
): Promise<ProjectLifecycleResult>;
```

- [ ] Run archive/restore/delete under the existing project lock. Mark `deletingAt` durably before cleanup, remove global project-owned state, then remove the managed project registry directory last.
- [ ] Add a startup recovery entry point that resumes owner-scoped tombstones without exposing them in normal reads.
- [ ] Add route tests first for `GET /api/workspace/projects?visibility=active|archived|all`, `POST /api/projects/:slug/actions`, malformed bodies, oversized bodies, invalid slugs, unauthorized owners, safe error copy, and the compatibility DELETE confirmation requirement.
- [ ] Confirm route tests fail, then wire Zod 4 boundary schemas and `bodyLimit` before body parsing. Keep route handlers thin and inject the lifecycle service at registration time.
- [ ] Re-run service and route suites to GREEN.

## Task 4: CLI confirmation compatibility

**Files:**

- Modify: `bin/cli.ts`
- Modify: the existing CLI tests located with `rg -n "project rm" tests bin`

- [ ] Add failing CLI tests showing `project rm <slug>` without confirmation exits without a request, while `project rm <slug> --confirm <project-name>` sends the explicit delete action payload.
- [ ] Confirm RED, then update help text, argument parsing, and request body. Never keep a bodyless destructive call path.
- [ ] Re-run focused CLI tests to GREEN.

## Task 5: Electron lifecycle state and post-success reconciliation

**Files:**

- Create: `desktop/src/renderer/src/stores/project-lifecycle.ts`
- Create: `tests/desktop/project-lifecycle-store.test.ts`
- Modify: `desktop/src/renderer/src/stores/board.ts`
- Modify: `desktop/src/renderer/src/stores/tabs.ts`
- Modify: `desktop/src/renderer/src/stores/project-workspaces.ts`
- Modify: `desktop/src/renderer/src/stores/project-view.ts`
- Modify: `tests/desktop/board-store.test.ts`
- Modify: `tests/desktop/tabs-store.test.ts`

- [ ] Add failing store tests proving archive/delete keep the active project and tabs intact while the request is pending or fails.
- [ ] Add failing success tests proving the action refreshes active/archived projections, closes every project tab, clears board/workspace/view caches, selects Home if necessary, and refreshes coding-agent summaries.
- [ ] Confirm RED with focused Desktop Vitest commands.
- [ ] Implement a focused store with `loadArchivedProjects`, `archiveProject`, `restoreProject`, and `deleteProject`. Allowlist/cap server error strings and use a generic fallback.
- [ ] Add pure, independently tested `closeProjectTabs`, `clearProjectWorkspace`, and `clearProjectView` helpers. Reconcile only after the Gateway confirms success; guard stale runtime generations.
- [ ] Re-run the focused suites to GREEN and ensure Zustand selectors return stable slices.

## Task 6: Sidebar actions and confirmation dialogs

**Files:**

- Create: `desktop/src/renderer/src/features/mission-control/ProjectSidebarRow.tsx`
- Create: `desktop/src/renderer/src/features/mission-control/ProjectLifecycleDialog.tsx`
- Modify: `desktop/src/renderer/src/features/mission-control/Sidebar.tsx`
- Create: `tests/desktop/project-sidebar-row.test.tsx`
- Create: `tests/desktop/project-lifecycle-dialog.test.tsx`

- [ ] Add failing component tests for keyboard-accessible overflow actions, row-click isolation, archive confirmation copy, exact-name delete gating, pending-state disablement, and external-folder preservation copy.
- [ ] Confirm RED, then implement with existing Radix menu/dialog primitives and brand tokens.
- [ ] Keep project navigation unchanged when the overflow trigger is used. Focus must return predictably after cancel or failure.
- [ ] Re-run component tests to GREEN.

## Task 7: Settings archived-project management

**Files:**

- Create: `desktop/src/renderer/src/features/settings/sections/ProjectsSection.tsx`
- Modify: `desktop/src/renderer/src/features/settings/SettingsView.tsx`
- Create: `tests/desktop/projects-settings-section.test.tsx`
- Modify: `tests/desktop/settings-view.test.tsx`

- [ ] Add failing tests for the Machine > Projects navigation item, loading/empty/error states, archived project metadata, restore, and delete dialog reuse.
- [ ] Confirm RED, then render the archived projection from the lifecycle store; do not duplicate lifecycle rules in the component.
- [ ] Re-run focused Settings tests to GREEN.

## Task 8: Full-path verification and polish

**Files:**

- Modify: `tests/e2e/desktop/fixtures/stub-gateway.ts`
- Add or modify: the closest existing Electron project-navigation E2E spec under `tests/e2e/desktop/`
- Modify: `specs/110-desktop-project-lifecycle/spec.md` only if implementation evidence changes an approved invariant

- [ ] Extend the stub Gateway with active/archived projections and lifecycle transitions.
- [ ] Add an E2E flow: create/open project, archive from sidebar, restore from Settings, then delete with typed confirmation and verify it remains absent.
- [ ] Run focused Gateway and Desktop tests.
- [ ] Run `flox activate -- pnpm --filter desktop run typecheck`.
- [ ] Run `flox activate -- bun run build:desktop`.
- [ ] Run `./scripts/review/check-patterns.sh --diff origin/main` and `git diff --check`.
- [ ] Launch the packaged-preview Desktop with `flox activate -- pnpm --filter desktop exec electron-vite preview`, manually validate Canvas first and Desktop compatibility second, and capture screenshots of sidebar menu, archive confirmation, Settings archived list, and typed delete confirmation.
- [ ] Commit the verified Gateway and Desktop increments with Conventional Commit messages.
- [ ] Update MAT-267 in English with implementation and verification evidence. Do not push or open PR until the user authorizes publishing.

## Task 9: Publication after explicit authorization

**Files:**

- Matrix OS PR body in GitHub (English)
- Separate public docs change in `FinnaAI/matrix-os-site/content/docs/` (English)

- [ ] Push the feature branch and open a Matrix OS PR with a Conventional Commit title and mandatory invariants: source of truth, lock/transaction scope, acceptable orphan states, auth source of truth, and deferred scope.
- [ ] Open a separate docs-site PR explaining archive/restore/delete behavior and external-folder preservation.
- [ ] Monitor CI and Greptile, resolve every finding or link an explicit follow-up, and stop before merge unless Greptile is 5/5 and the user authorizes landing.
