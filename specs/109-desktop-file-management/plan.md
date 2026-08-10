# Desktop File Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan. Use the repository TDD skill for every behavior change.

**Goal:** Deliver MAT-268 as a production-grade Desktop Files workflow for structural CRUD, current-directory multi-selection, safe batch move/Trash, and authoritative realtime reconciliation.

**Architecture:** Add shared Zod contracts and focused file-management services beside the existing Gateway file routes. The Gateway owns capabilities, path policy, idempotency, conflict resolution, and per-item outcomes. A bounded directory-subscription hub converts watcher events into authenticated current-directory hints. Desktop keeps serializable selection/operation state, calls the public contracts through `ApiClient`, and always reconciles via authoritative listings. Existing Shell behavior is reference UX only; MAT-268 does not reuse its unsafe independent request fan-out.

**Tech Stack:** Node.js 24 `fs/promises`, TypeScript strict ES modules, Hono, Zod 4, React 19, Electron, Vitest, React Testing Library, Flox, pnpm 10, Bun scripts.

**Global Constraints:** Work only in the manual MAT-268 worktree; preserve the dirty root checkout. Red → Green → Refactor for every slice. Never overwrite a destination or permanently delete content. All online PR/issue/docs text is English. Do not merge. Public docs ship as a separate `FinnaAI/matrix-os-site` PR after implementation behavior stabilizes.

---

## Task 1: Lock the spec and baseline

**Files:**

- Create: `specs/109-desktop-file-management/spec.md`
- Create: `specs/109-desktop-file-management/plan.md`
- Reference: `specs/048-file-browser/spec.md`
- Reference: `docs/dev/large-file-refactoring.md`

- [x] Capture the confirmed MAT-268 scope, UX rules, contracts, auth matrix, resource bounds, acceptable orphan state, public test seams, and follow-up boundaries.
- [x] Spike Node 24 directory copy semantics: a missing target is exclusively created; an existing target produces `ERR_FS_CP_EEXIST` with `force: false` and `errorOnExist: true`. Minimal reproducible evidence:

  ```bash
  flox activate -- node --input-type=module -e 'import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"; import { join } from "node:path"; import { tmpdir } from "node:os"; const root = await mkdtemp(join(tmpdir(), "mat268-cp-")); try { const source = join(root, "source"); const target = join(root, "target"); await mkdir(source); await writeFile(join(source, "proof.txt"), "source"); await cp(source, target, { recursive: true, force: false, errorOnExist: true }); let existingTargetCode = "none"; try { await cp(source, target, { recursive: true, force: false, errorOnExist: true }); } catch (error) { existingTargetCode = error.code; } console.log(JSON.stringify({ createdTargetContent: await readFile(join(target, "proof.txt"), "utf8"), existingTargetCode })); } finally { await rm(root, { recursive: true, force: true }); }'
  ```

  Output: `{"createdTargetContent":"source","existingTargetCode":"ERR_FS_CP_EEXIST"}`.
- [x] Run the untouched focused baseline:

  ```bash
  flox activate -- bun run test tests/gateway/file-ops.test.ts tests/gateway/trash.test.ts tests/gateway/watcher.test.ts tests/desktop/files-browser-views.test.tsx tests/desktop/files-workspace.test.tsx
  ```

  Expected: 5 files and 91 tests pass; existing React `act(...)` warnings are recorded as baseline noise.

  **Baseline evidence (2026-08-10):** the untouched command passed: 5 test files, 91 tests. The known React `act(...)` warnings occurred in the two `FilesWorkspace` session-scope tests and remain baseline noise; this task does not change them.

## Task 2: Add shared file-management contracts, structural mutations, and policy

**Files:**

- Create: `packages/gateway/src/file-management/contracts.ts`
- Create: `packages/gateway/src/file-management/policy.ts`
- Modify: `packages/gateway/src/files-tree.ts`
- Modify: `packages/gateway/src/path-security.ts`
- Modify: `packages/gateway/src/file-ops.ts`
- Test: `tests/gateway/file-management-contracts.test.ts`
- Test: `tests/gateway/files-tree.test.ts`
- Test: `tests/gateway/file-ops.test.ts`

- [ ] Write failing schema tests for UUID request IDs, 1–100 unique same-parent sources, 4,096-byte paths, 255-byte names, typed create/rename payloads, discriminated preflight/execute requests with an execution fingerprint, bounded conflict choices, and stable result codes.
- [ ] Write failing policy tests showing protected/hidden roots expose `canRename: false`, `canMove: false`, `canTrash: false`, while ordinary owner files expose all three capabilities.
- [ ] Run the focused tests and confirm RED because contracts/capabilities do not exist.
- [ ] Implement exported Zod schemas and inferred types using `zod/v4`.
- [ ] Implement one normalized mutation policy used by both listing and execution. Reject traversal, absolute paths, denied roots, symlink escapes, home root mutation, separators/control characters, and platform-reserved names.
- [ ] Harden the existing create/rename service seam for typed Desktop contracts: re-authorize the source/parent and name immediately before the filesystem operation, use exclusive creation, reject occupied rename targets, and return only normalized relative paths plus safe capability/result data. Preserve and separately test compatibility handling for existing callers until it is explicitly removed.
- [ ] Extend directory listings with the capability object without breaking existing fields.
- [ ] Run focused tests and confirm GREEN, then refactor duplicate path checks into pure helpers.

## Task 3: Implement bounded idempotency and preflight

**Files:**

- Create: `packages/gateway/src/file-management/result-cache.ts`
- Create: `packages/gateway/src/file-management/preflight.ts`
- Test: `tests/gateway/file-operation-result-cache.test.ts`
- Test: `tests/gateway/file-batch-preflight.test.ts`

- [ ] Write failing fake-clock tests for 512-entry LRU eviction, 10-minute TTL expiry, identical replay, in-flight promise sharing, `request_id_conflict` for a payload mismatch, separate preflight/execute namespaces for a shared request ID, and cross-owner isolation for identical client UUIDs.
- [ ] Write failing preflight tests for deterministic source order, same-parent enforcement, source-not-found, protected items, current-directory destination, directory self/descendant destinations, and ordered conflicts.
- [ ] Run both tests and confirm RED.
- [ ] Implement canonical payload hashing with stable JSON fields; never include auth tokens or absolute paths. Key every cache entry by authenticated owner/principal ID, operation namespace, and request ID; preflight hashes normalized source/destination fields, while execute hashes its preflight fingerprint and ordered conflict choices.
- [ ] Implement the bounded cache with explicit `close()` clearing timers/maps.
- [ ] Implement preflight from freshly resolved filesystem state and shared mutation policy.
- [ ] Run tests and confirm GREEN.

## Task 4: Implement safe per-item move and batch execution

**Files:**

- Create: `packages/gateway/src/file-management/move.ts`
- Create: `packages/gateway/src/file-management/batch-service.ts`
- Modify: `packages/gateway/src/file-ops.ts`
- Test: `tests/gateway/file-batch-move.test.ts`

- [ ] Write failing tests for file and directory move, Finder-style Keep Both names, atomic target-name conflicts, skip, cancel-before-execute, no overwrite, source removal only after copy success, removal-failure duplicate reporting, 100-item cap, and ordered partial results.
- [ ] Add concurrent tests where two requests claim the same Keep Both name and both preserve content under distinct names.
- [ ] Add symlink, traversal, protected-root, self/descendant, and stale-preflight tests.
- [ ] Run the focused test and confirm RED.
- [ ] Implement `fs.cp(source, missingTarget, { recursive: true, force: false, errorOnExist: true })`, retrying bounded Keep Both candidates on `EEXIST`; remove the source only after a confirmed copy.
- [ ] Return stable per-item codes such as `moved`, `skipped`, `source_missing`, `destination_conflict`, `protected`, `invalid_destination`, and `cleanup_failed`; log raw errors only on the server.
- [ ] Compose deterministic sequential execution through the result cache. Do not add a batch-wide rollback.
- [ ] Run focused tests and confirm GREEN.

## Task 5: Implement batch Trash and harden manifest serialization

**Files:**

- Modify: `packages/gateway/src/trash.ts`
- Modify: `packages/gateway/src/file-management/batch-service.ts`
- Test: `tests/gateway/trash.test.ts`
- Test: `tests/gateway/file-batch-trash.test.ts`

- [ ] Write failing tests for ordered per-item Trash results, protected items, partial failure, replay, request mismatch, symlink escape, and max 100 sources.
- [ ] Write failing tests proving manifest locks are bounded, idle lock entries are removed, malformed manifests do not masquerade as empty Trash, and shutdown clears owned resources.
- [ ] Run tests and confirm RED.
- [ ] Replace the module-global unbounded mutex map with a per-home bounded keyed queue owned by the file-management service; inject it into Trash operations.
- [ ] Distinguish ENOENT from malformed/read failures, use request-safe generic results, and preserve atomic temporary-manifest rename.
- [ ] Execute each Trash item under the home manifest queue and return failed items without clearing unrelated successful results.
- [ ] Run focused tests and confirm GREEN.

## Task 6: Register typed HTTP routes and integration wiring

**Files:**

- Create: `packages/gateway/src/server/file-management-routes.ts`
- Modify: `packages/gateway/src/server/file-routes.ts`
- Modify: `packages/gateway/src/server.ts`
- Test: `tests/gateway/file-management-routes.test.ts`
- Test: `tests/gateway/server-route-registrars.test.ts`

- [ ] Write failing Hono integration tests for auth enforcement, 128 KiB body limit, malformed JSON, schema errors, list capabilities, typed create/rename re-authorization and exclusive-conflict behavior, preflight, execute with a required fingerprint, same-owner replay, cross-owner request-ID isolation, payload mismatch, batch Trash, safe 4xx/5xx bodies, and service disposal.
- [ ] Run tests and confirm RED.
- [ ] Register explicit typed `/api/files/create`, `/api/files/rename`, `/api/files/batch/move`, and `/api/files/batch/trash` endpoints after global auth middleware. Parse Zod schemas at the route boundary and map typed service errors once; preserve compatibility handling for legacy create/rename callers at that boundary until removal is separately approved.
- [ ] Resolve all service dependencies during route registration and add service `close()` to Gateway shutdown before shared watcher/auth dependencies are destroyed.
- [ ] Run focused tests and confirm GREEN.

## Task 7: Add authenticated current-directory subscriptions

**Files:**

- Create: `packages/gateway/src/file-management/directory-subscriptions.ts`
- Modify: `packages/gateway/src/watcher.ts`
- Modify: `packages/gateway/src/ws-message-schema.ts`
- Modify: `packages/gateway/src/server/types.ts`
- Modify: `packages/gateway/src/server.ts`
- Test: `tests/gateway/file-directory-subscriptions.test.ts`
- Test: `tests/gateway/watcher.test.ts`
- Test: `tests/gateway/ws-message-schema.test.ts`

- [ ] Write failing hub tests for owner/connection/directory keys, 1,024 global cap, eight-directory connection cap, 32-connection owner cap, five-minute stale eviction, touch, monotonic revisions, irrelevant-directory filtering, failed-send isolation/eviction, and shutdown drain.
- [ ] Write failing WebSocket integration tests for authenticated subscribe/unsubscribe, rejected invalid/protected directories, awaited success, schema-bounded frames, reconnect revision reset, and generic error closure.
- [ ] Write failing watcher tests proving subscribed user-visible roots, including `projects`, can produce hints without globally traversing every project at startup.
- [ ] Run tests and confirm RED.
- [ ] Implement a lazily scoped per-directory watcher/subscription hub or extend the watcher with reference-counted directory scopes; never broaden startup traversal to the whole home.
- [ ] Bind every subscription to the authenticated upgrade principal and connection ID. Validate every inbound frame with Zod.
- [ ] Broadcast best-effort hints, evict failed senders, sweep stale subscriptions before caps, and drain/close on Gateway shutdown.
- [ ] Run focused tests and confirm GREEN.

## Task 8: Add Desktop API/controller state with reconciliation

**Files:**

- Create: `desktop/src/renderer/src/features/files/file-management-api.ts`
- Create: `desktop/src/renderer/src/features/files/file-operation-controller.ts`
- Create: `desktop/src/renderer/src/features/files/file-selection.ts`
- Create: `desktop/src/renderer/src/features/files/use-directory-sync.ts`
- Modify: `desktop/src/renderer/src/features/files/browser-entries.ts`
- Modify: `desktop/src/renderer/src/lib/kernel-socket.ts`
- Test: `tests/desktop/file-management-api.test.ts`
- Test: `tests/desktop/file-operation-controller.test.ts`
- Test: `tests/desktop/file-selection.test.ts`
- Test: `tests/desktop/file-directory-sync.test.tsx`

- [ ] Write failing pure selection tests for macOS Command, Windows/Linux Control, Shift range, drag-selected vs drag-unselected, navigation reset, scope reset, and refresh reconciliation.
- [ ] Write failing controller tests for unique request IDs, preflight/execute, conflict choices, pending rows, partial success, failed-item retention, source/destination reloads, timeout/reconnect/restart reconciliation, stale runtime/auth-generation suppression, and bounded safe errors.
- [ ] Write failing directory-sync tests for subscribe/unsubscribe/touch, 150 ms debounced reload, revision gaps, reconnect, and stale-scope suppression.
- [ ] Run tests and confirm RED.
- [ ] Implement serializable arrays/records; do not place `Set`/`Map` in shared state and do not allocate unstable Zustand selector objects.
- [ ] Extend the existing authenticated `KernelSocket` message types and public subscription seam for `files:*` without adding native filesystem IPC.
- [ ] Implement authoritative reconciliation helpers shared by tests and UI.
- [ ] Run tests and confirm GREEN.

## Task 9: Build create/rename/menu/multi-select UI

**Files:**

- Create: `desktop/src/renderer/src/features/files/FileActionMenu.tsx`
- Create: `desktop/src/renderer/src/features/files/InlineNameEditor.tsx`
- Create: `desktop/src/renderer/src/features/files/FileOperationNotice.tsx`
- Modify: `desktop/src/renderer/src/features/files/ComputerFileBrowser.tsx`
- Modify: `desktop/src/renderer/src/features/files/browser-views.tsx`
- Modify: `desktop/src/renderer/src/features/files/FilesWorkspace.tsx`
- Test: `tests/desktop/files-browser-views.test.tsx`
- Test: `tests/desktop/files-workspace.test.tsx`
- Test: `tests/desktop/files-management-ui.test.tsx`

- [ ] Write failing rendered tests for empty-space and toolbar create, Escape cancellation with no request, explicit submit, blur preservation, invalid-name feedback, exclusive conflict feedback, single-item rename, capability-disabled actions, context menu, `···`, and `Open in Editor` when available.
- [ ] Write failing rendered tests for click/toggle/range selection, focus-driven preview, refresh retention, navigation/scope clearing, batch-limit explanation, pending row disabling, partial-result messaging, and keyboard/screen-reader labels.
- [ ] Run tests and confirm RED.
- [ ] Extract controller/state hooks before adding behavior to `ComputerFileBrowser.tsx`; keep composition files below the repository large-file thresholds.
- [ ] Implement the menus, inline editor, accessible selection semantics, and notices using Desktop design primitives/tokens and the typed re-authorized create/rename API contracts.
- [ ] Run focused tests and confirm GREEN.

## Task 10: Add folder picker and internal drag-to-move

**Files:**

- Create: `desktop/src/renderer/src/features/files/MoveFilesDialog.tsx`
- Create: `desktop/src/renderer/src/features/files/file-drag.ts`
- Modify: `desktop/src/renderer/src/features/files/ComputerFileBrowser.tsx`
- Modify: `desktop/src/renderer/src/features/files/browser-views.tsx`
- Test: `tests/desktop/file-drag.test.ts`
- Test: `tests/desktop/files-management-ui.test.tsx`

- [ ] Write failing tests for dragging a selected item as the full selection, replacing selection when dragging an unselected item, focused-item preview/count badge, visible-folder and breadcrumb targets, current-directory/source/descendant rejection, folder-picker navigation, and non-drag move parity.
- [ ] Write platform-semantics tests for `metaKey` on macOS and `ctrlKey` on Windows/Linux without depending on the host test runner OS.
- [ ] Run tests and confirm RED.
- [ ] Implement an internal MIME payload containing only normalized owner-relative paths and request scope. Reject external file drops here so MAT-261 upload remains authoritative.
- [ ] Use the same controller for dialog and drag execution, conflicts, pending state, and reconciliation.
- [ ] Run focused tests and confirm GREEN.

## Task 11: Verification and documentation handoff

**Files:**

- Modify if needed: `specs/109-desktop-file-management/spec.md`
- External repository: `FinnaAI/matrix-os-site/content/docs/`

- [ ] Run all focused MAT-268 and regression tests.
- [ ] Run Gateway and Desktop typechecks:

  ```bash
  flox activate -- pnpm --filter @matrix-os/gateway exec tsc --noEmit
  flox activate -- pnpm --filter desktop run typecheck
  ```

- [ ] Run the canonical production Desktop build:

  ```bash
  flox activate -- bun run build:desktop
  ```

- [ ] Launch the real Electron Desktop from this exact worktree/commit, verify the process path and renderer bundle, and collect macOS evidence for create, rename, multi-select, folder-picker move, drag move, Trash, partial failure, runtime/auth switch, and Terminal/Agent external change refresh.
- [ ] Record Windows/Linux automated modifier/path/keyboard results separately from macOS live evidence.
- [ ] Inspect the final diff for raw error leaks, unbounded collections, unsafe destination overwrites, renderer-only authorization, stale-scope writes, and files over repository size thresholds.
- [ ] Update the spec if final behavior differs, then create a separate English documentation PR in `FinnaAI/matrix-os-site` describing shipped Desktop Files behavior and limitations.
- [ ] Commit working increments with Conventional Commits, push, and open an English Conventional Commit PR referencing MAT-268 and GitHub #1183. Include source-of-truth, lock/transaction scope, acceptable orphan state, auth source of truth, and deferred scope invariants.
- [ ] Monitor CI and Greptile; fix every actionable finding or defer it in the PR body with a linked follow-up. Stop before merge after Greptile reaches 5/5.
