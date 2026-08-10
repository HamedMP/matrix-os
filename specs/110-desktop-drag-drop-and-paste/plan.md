# Desktop Drag, Drop, and Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store transient Desktop composer and Terminal uploads under the owner's
`~/temporary/` directory without changing upload endpoint schemas or Files-browser
destinations.

**Architecture:** The Desktop composer continues using `PUT /api/files/blob`, but
selects the `temporary/desktop-chat/` owner-relative prefix. The existing Gateway
Terminal paste helper continues validating and atomically writing uploaded images,
but selects `temporary/terminal-pastes/<date>/` independently of terminal cwd.

**Tech Stack:** TypeScript 5.9 strict, React 19, Electron 41, Hono, Node.js 24
`fs/promises`, Vitest 4, pnpm 10, bun scripts.

## Global Constraints

- Keep each file at or below 10 MiB and existing upload concurrency/timeouts unchanged.
- Keep `PUT /api/files/blob` and
  `POST /api/terminal/sessions/:name/paste-assets` request/response schemas unchanged.
- Keep Files-browser uploads in the user-visible target directory.
- Keep path confinement, magic-byte validation, exclusive temporary writes, and
  atomic rename behavior unchanged.
- Do not add cleanup behavior; `MAT-269` owns that follow-up.
- Do not modify CLI, Shell, Mobile, conversation, or terminal-session code.

---

## Invariants

- Diff scope is `desktop/`, the existing Gateway Terminal paste-asset storage helper
  and its focused tests, this spec directory, and canonical Terminal paste contract
  documents under `specs/106-terminal-rich-paste/` only.
- Reuse `PUT /api/files/blob` and `POST /api/terminal/sessions/:name/paste-assets`
  without changing either endpoint contract.
- Implement one vertical Red -> Green slice at a time.
- Keep the current full Gateway implementation preserved on
  `codex/mat-261-full-gateway-backup` until Preview validation completes.

## Task 1: Desktop binary upload seam

- [x] Add failing `ApiClient` tests for bounded Blob PUT/POST requests.
- [x] Add the minimal binary request methods.
- [x] Add failing Electron CORS coverage for `X-Matrix-Filename`.
- [x] Allow that existing Gateway request header.

## Task 2: Files drag/drop and paste

- [x] Add failing `ComputerFileBrowser` behavior tests.
- [x] Implement a bounded Desktop file upload controller over `/api/files/blob`.
- [x] Wire drop and clipboard-file paste only in browse mode.
- [x] Show ordered progress, conflict, Retry, and Remove states.

## Task 3: Shared Desktop composer previews

- [x] Add failing preview-row and local controller tests.
- [x] Implement ordered horizontal previews, image object-URL lifecycle, remove/retry,
  eight-file cap, three-upload concurrency, and runtime invalidation.
- [x] Keep the implementation renderer-local and serializable at store boundaries.

## Task 4: Chat and Project Chat submission

- [x] Add failing Chat tests for path-prompt submission and failure retention.
- [x] Add failing Project Chat tests for existing `structured_ref` payloads.
- [x] Wire new thread, follow-up turn, and Hermes Send without changing shared contracts.

## Task 5: Terminal image paste/drop

- [x] Add failing `TerminalView` tests for paste and drop.
- [x] Add Desktop-local MIME/size, response, and bracketed-paste helpers.
- [x] Start bounded uploads concurrently, preserve input order in the returned paths,
  and write exactly once per completed batch.
- [x] Verify no Enter and normal text paste fallback.

## Task 6: Verification and PR replacement

- [x] Run all changed-area tests.
- [x] Run Desktop and Gateway type checks plus diff pattern checks.
- [x] Build the production Desktop app.
- [ ] Exercise all four surfaces in the real Electron app.
- [ ] Force-update PR #1174 with `--force-with-lease` only after local verification.
- [ ] Deploy and verify the Preview VPS before marking the PR ready.
- [ ] Prepare the separate public documentation PR after implementation approval.

## Task 7: Move composer uploads into owner temporary storage

**Files:**

- Modify: `tests/desktop/local-attachment-controller.test.ts`
- Verify unchanged: `tests/desktop/files-upload.test.tsx`
- Modify: `desktop/src/renderer/src/features/chat/attachments/local-attachment-controller.ts`

**Interfaces:**

- Consumes: existing `createLocalAttachmentController({ api, createId })` and
  `ApiClient.putBytes()` contracts.
- Produces: owner-relative paths matching
  `temporary/desktop-chat/<uploadId>-<safe filename>` for both Hermes paths and
  Project Chat `structured_ref.path` values.

- [x] **Step 1: RED — change the controller contract expectations**

  Update the stable expected upload path and URL assertions in
  `tests/desktop/local-attachment-controller.test.ts` from
  `uploads/desktop-chat/...` to `temporary/desktop-chat/...`, including:

  ```ts
  expect(putBytes).toHaveBeenNthCalledWith(
    1,
    "/api/files/blob?path=temporary%2Fdesktop-chat%2Fstable_0-first.txt",
    expect.any(File),
    { "content-type": "text/plain" },
    { timeoutMs: 30_000 },
  );
  ```

- [x] **Step 2: Run RED and confirm the old prefix is the failure**

  Run:

  ```bash
  bun run test -- tests/desktop/local-attachment-controller.test.ts
  ```

  Expected: FAIL because the controller still sends and returns
  `uploads/desktop-chat/...`.

- [x] **Step 3: GREEN — change only the composer upload prefix**

  In `local-attachment-controller.ts`, construct new items with:

  ```ts
  uploadPath: `temporary/desktop-chat/${uploadId}-${file.name}`,
  ```

- [x] **Step 4: Run the composer and Files tests**

  Run:

  ```bash
  bun run test -- \
    tests/desktop/local-attachment-controller.test.ts \
    tests/desktop/files-upload.test.tsx
  ```

  Expected: PASS. The Files tests must continue asserting visible destinations such
  as `projects/notes.md` and root `pasted.txt`, never `temporary/...`.

## Task 8: Move Terminal paste assets into owner temporary storage

**Files:**

- Modify: `tests/gateway/shell-routes.test.ts`
- Modify: `packages/gateway/src/shell/paste-assets.ts`

**Interfaces:**

- Consumes: existing `saveTerminalPasteAsset(TerminalPasteAssetInput)` and
  `POST /api/terminal/sessions/:name/paste-assets` contracts.
- Produces: unchanged `{ path, terminalPath, size, mimeType }` response shape with
  `path` rooted at `temporary/terminal-pastes/<YYYY-MM-DD>/` and `terminalPath`
  rooted at `/home/matrix/home/temporary/terminal-pastes/<YYYY-MM-DD>/` in production.

- [x] **Step 1: RED — change the Gateway route expectation**

  Rename the route test to `uploads pasted terminal image assets into the owner
  temporary directory` and assert:

  ```ts
  expect(body.path).toMatch(
    /^temporary\/terminal-pastes\/\d{4}-\d{2}-\d{2}\//,
  );
  expect(body.path).not.toContain("projects/app");
  expect(body.terminalPath).toBe(join(root, body.path));
  await expect(readFile(body.terminalPath)).resolves.toEqual(Buffer.from(PNG_BYTES));
  ```

  The temporary directory must not be pre-created in test setup; the successful
  `readFile` assertion proves recursive creation and the final atomic file write.

- [x] **Step 2: Run RED and confirm the old cwd-scoped path is the failure**

  Run:

  ```bash
  bun run test -- tests/gateway/shell-routes.test.ts
  ```

  Expected: FAIL because the response still starts with
  `projects/app/.matrix-terminal-pastes/`.

- [x] **Step 3: GREEN — select the owner temporary directory**

  In `saveTerminalPasteAsset`, preserve all validation and atomic write code and
  change only the directory selection:

  ```ts
  const relativeDir = join("temporary", "terminal-pastes", date);
  ```

  Keep `cwd` in `TerminalPasteAssetInput` and keep route-level cwd validation for
  backward compatibility; storage must no longer depend on its value.

- [x] **Step 4: Run the focused Gateway route test**

  Run:

  ```bash
  bun run test -- tests/gateway/shell-routes.test.ts
  ```

  Expected: PASS, including unsafe magic bytes, traversal cwd, unsafe filename,
  missing-session, and body-limit cases.

## Task 9: Synchronize contracts and verify the complete change

**Files:**

- Modify: `specs/106-terminal-rich-paste/data-model.md`
- Modify: `specs/106-terminal-rich-paste/quickstart.md`
- Modify: `specs/106-terminal-rich-paste/pr-invariants.md`
- Modify: `specs/106-terminal-rich-paste/contracts/paste-assets.md`
- Modify: `specs/106-terminal-rich-paste/tasks.md`
- Modify: `specs/110-desktop-drag-drop-and-paste/plan.md`

**Interfaces:**

- Consumes: the new paths proven by Tasks 7 and 8.
- Produces: one consistent documented storage contract and verification record.

- [ ] **Step 1: Replace authoritative path examples**

  Change current server-owned destination examples from
  `projects/.matrix-terminal-pastes/...` to
  `temporary/terminal-pastes/...`. Do not mechanically rewrite sync-client test
  fixtures: they intentionally prove clients accept authenticated owner-home paths
  independent of the server's current destination convention.

- [ ] **Step 2: Run focused regression tests**

  Run:

  ```bash
  bun run test -- \
    tests/desktop/local-attachment-controller.test.ts \
    tests/desktop/files-upload.test.tsx \
    tests/desktop/terminal-view.test.tsx \
    tests/gateway/shell-routes.test.ts \
    tests/cli/shell-client.test.ts \
    tests/shell/terminal-pane-privacy.test.tsx
  ```

- [ ] **Step 3: Run static and production verification**

  Run:

  ```bash
  bun run typecheck
  bun run check:patterns:diff
  bun run build:desktop
  git diff --check
  ```

- [ ] **Step 4: Run the repository-wide suite and classify failures**

  Run:

  ```bash
  bun run test
  ```

  Compare any failures with the pre-change baseline recorded in the PR. Do not report
  unrelated baseline failures as regressions.

- [ ] **Step 5: Commit, push, and validate exact-head Preview**

  Commit the implementation with a Conventional Commit message, push to
  `codex/mat-261-gateway-attachments`, update PR #1174 and MAT-261 in English, then
  deploy and verify the exact Preview bundle. Confirm:

  ```text
  Chat / Project Chat: ~/temporary/desktop-chat/...
  Terminal: ~/temporary/terminal-pastes/<date>/...
  Files browser: the user-visible destination remains unchanged
  ```

  Do not merge until Greptile reviews the new head at 5/5.
