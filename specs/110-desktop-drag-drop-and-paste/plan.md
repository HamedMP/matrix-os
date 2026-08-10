# Desktop Drag, Drop, and Paste Implementation Plan

## Invariants

- Diff scope is `desktop/`, Desktop tests, and this spec directory only.
- Reuse `PUT /api/files/blob` and `POST /api/terminal/sessions/:name/paste-assets`
  unchanged.
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
- [x] Upload sequentially to preserve order and write exactly once per completed batch.
- [x] Verify no Enter and normal text paste fallback.

## Task 6: Verification and PR replacement

- [x] Run all changed-area tests.
- [x] Run Desktop and Gateway type checks plus diff pattern checks.
- [x] Build the production Desktop app.
- [ ] Exercise all four surfaces in the real Electron app.
- [ ] Force-update PR #1174 with `--force-with-lease` only after local verification.
- [ ] Deploy and verify the Preview VPS before marking the PR ready.
- [ ] Prepare the separate public documentation PR after implementation approval.
