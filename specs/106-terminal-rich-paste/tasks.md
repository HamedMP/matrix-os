# Tasks: Attached Terminal Rich Paste

**Input**: Design documents from `specs/106-terminal-rich-paste/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Required. The Matrix OS constitution and this feature's quickstart require TDD, so each user story begins with failing Vitest/gateway tests.

**Organization**: Tasks are grouped by user story so each story can be implemented, reviewed, and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files or depends only on completed setup/foundation.
- **[Story]**: Required only for user story phases.
- Each task includes exact repository file paths.

## Phase 1: Setup

**Purpose**: Confirm implementation guardrails and documentation targets before changing product code.

- [X] T001 Verify implementation work is happening in a manual git worktree and planned Graphite stack per `docs/dev/stacked-prs.md` and `docs/dev/review-pipeline.md`
- [X] T002 [P] Confirm public documentation update targets for the feature in `www/content/docs/cli.mdx`, `www/content/docs/guide/cli.mdx`, and `www/content/docs/shell.mdx`

---

## Phase 2: Foundational

**Purpose**: Add shared scaffolding that all three stories need before behavior implementation.

**CRITICAL**: No user story implementation should begin until these shared scaffolds exist.

- [X] T003 [P] Define `PasteTransaction`, `LocalImageCandidate`, `ClipboardImageCandidate`, `RemotePasteAsset`, and `RewriteResult` types with constants in `packages/sync-client/src/cli/rich-paste.ts`
- [X] T004 [P] Define injectable clipboard image reader interfaces and unsupported-platform result types in `packages/sync-client/src/cli/clipboard-image.ts`
- [X] T005 [P] Define paste asset route constants, image type metadata, cleanup policy types, and safe error codes in `packages/gateway/src/shell/paste-assets.ts`
- [X] T006 Add rich paste dependency injection options to `ShellAttachOptions` in `packages/sync-client/src/cli/shell-client.ts`
- [X] T007 Add paste asset service dependencies to `ShellRouteDeps` in `packages/gateway/src/shell/routes.ts`
- [X] T008 Instantiate the paste asset service and cleanup lifecycle placeholders near shell route wiring in `packages/gateway/src/server.ts`

**Checkpoint**: Shared types, dependency seams, and lifecycle seams exist with no rich paste behavior yet.

---

## Phase 3: User Story 1 - Paste Screenshot Path Inside Prompt (Priority: P1)

**Goal**: A user can paste a local screenshot path inside a larger prompt and the attached remote session receives a prompt containing an owner-scoped Matrix path plus the original surrounding text.

**Independent Test**: Attach to a session, paste `"local screenshot path.png" what about this?`, and verify the outgoing terminal input frame contains a remote Matrix path and the user's question, with no local `/var/folders/...` path.

### Tests for User Story 1

> Write these tests first and confirm they fail before implementation.

- [X] T009 [P] [US1] Add failing gateway contract tests for successful multipart image upload and server-generated paths in `tests/gateway/shell-routes.test.ts`
- [X] T010 [P] [US1] Add failing parser tests for quoted paths with spaces, unquoted image paths, non-image path passthrough, multiple image paths, and repeated image dedupe in `packages/sync-client/tests/unit/rich-paste.test.ts`
- [X] T011 [US1] Add failing attach-loop test that embedded local image paths are rewritten before `{ type: "input" }` frames in `packages/sync-client/tests/unit/shell-client.test.ts`

### Implementation for User Story 1

- [X] T012 [US1] Implement local image path tokenization for quoted and unquoted embedded paths in `packages/sync-client/src/cli/rich-paste.ts`
- [X] T013 [US1] Implement per-transaction dedupe and prompt rewrite output preserving text order and line breaks in `packages/sync-client/src/cli/rich-paste.ts`
- [X] T014 [US1] Implement gateway paste asset storage with server-generated owner-scoped paths under `projects/.matrix-terminal-pastes/` in `packages/gateway/src/shell/paste-assets.ts`
- [X] T015 [US1] Wire `POST /api/terminal/sessions/:name/paste-assets` into terminal routes with session-name validation in `packages/gateway/src/shell/routes.ts`
- [X] T016 [US1] Implement CLI multipart upload and response parsing for terminal paste assets in `packages/sync-client/src/cli/rich-paste.ts`
- [X] T017 [US1] Integrate rich paste rewriting into the attached-session input path before WebSocket input frames in `packages/sync-client/src/cli/shell-client.ts`
- [X] T018 [US1] Run and update the US1 quickstart validation commands in `specs/106-terminal-rich-paste/quickstart.md`

**Checkpoint**: User Story 1 is independently shippable as the MVP.

---

## Phase 4: User Story 2 - Paste Image Clipboard Without Path Text (Priority: P2)

**Goal**: When the terminal exposes an observable paste transaction and the macOS clipboard contains image bytes but no path text, the CLI inserts a usable remote Matrix image path.

**Independent Test**: Copy an image to the macOS clipboard, trigger an observable paste during `mos shell attach main`, and verify the outgoing prompt includes a Matrix-owned remote image path or a safe local unsupported-paste message when no paste signal exists.

### Tests for User Story 2

> Write these tests first and confirm they fail before implementation.

- [X] T019 [P] [US2] Add failing clipboard reader tests for supported macOS image output, unsupported platform, missing helper, empty clipboard, and timeout in `packages/sync-client/tests/unit/clipboard-image.test.ts`
- [X] T020 [P] [US2] Add failing observable paste tests for bracketed paste boundaries and image-only clipboard fallback in `packages/sync-client/tests/unit/shell-client.test.ts`

### Implementation for User Story 2

- [X] T021 [US2] Implement macOS clipboard image reader with injectable command execution, timeout handling, and safe unsupported results in `packages/sync-client/src/cli/clipboard-image.ts`
- [X] T022 [US2] Implement bracketed paste transaction collection without breaking ordinary terminal input filtering in `packages/sync-client/src/cli/rich-paste.ts`
- [X] T023 [US2] Add clipboard image candidates to the upload and rewrite pipeline without duplicating text-path uploads in `packages/sync-client/src/cli/rich-paste.ts`
- [X] T024 [US2] Wire observable paste handling and clipboard reader invocation into attach input handling in `packages/sync-client/src/cli/shell-client.ts`
- [X] T025 [US2] Run and update the US2 quickstart validation commands in `specs/106-terminal-rich-paste/quickstart.md`

**Checkpoint**: User Stories 1 and 2 both work independently.

---

## Phase 5: User Story 3 - Fail Safely Without Leaking Local Paths (Priority: P3)

**Goal**: Rich paste failures are local, retryable, bounded, and never forward detected local image paths or raw internal errors to the remote session.

**Independent Test**: Paste unreadable, missing, unsupported, oversized, and failed-upload images and verify local feedback appears while no detected local path reaches the remote terminal input stream.

### Tests for User Story 3

> Write these tests first and confirm they fail before implementation.

- [X] T026 [P] [US3] Add failing local validation tests for unreadable, missing, unsupported, oversized, symlink, and upload-failure cases in `packages/sync-client/tests/unit/rich-paste.test.ts`
- [X] T027 [P] [US3] Add failing gateway tests for bodyLimit, invalid session name, invalid image type, too many assets, oversized asset, generic error response, and temp cleanup in `tests/gateway/shell-routes.test.ts`
- [X] T028 [US3] Add failing attach-loop test that rich paste failures print safe local feedback and send no local image path frame in `packages/sync-client/tests/unit/shell-client.test.ts`

### Implementation for User Story 3

- [X] T029 [US3] Implement local image validation with regular-file checks, image signature/type checks, size caps, and symlink rejection in `packages/sync-client/src/cli/rich-paste.ts`
- [X] T030 [US3] Implement safe local error mapping and retryable feedback strings in `packages/sync-client/src/cli/rich-paste.ts`
- [X] T031 [US3] Enforce gateway bodyLimit, asset count, type, size, atomic exclusive writes, and generic error codes in `packages/gateway/src/shell/paste-assets.ts`
- [X] T032 [US3] Map paste asset route failures to generic client responses while logging diagnostics server-side in `packages/gateway/src/shell/routes.ts`
- [X] T033 [US3] Implement recurring paste asset cleanup with `lstat()` symlink skips, max age, and max count in `packages/gateway/src/shell/paste-assets.ts`
- [X] T034 [US3] Register paste asset cleanup startup and shutdown disposal in the gateway lifecycle in `packages/gateway/src/server.ts`
- [X] T035 [US3] Run and update the US3 quickstart validation commands in `specs/106-terminal-rich-paste/quickstart.md`

**Checkpoint**: All user stories are independently functional and failure-safe.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, validation, release readiness, and review preparation.

- [X] T036 [P] Document attached-session screenshot path paste behavior, limits, and safe failures in `www/content/docs/cli.mdx`
- [X] T037 [P] Document rich paste examples and terminal limitations in the guide CLI page `www/content/docs/guide/cli.mdx`
- [X] T038 [P] Document shared session behavior and rich paste scope for shell users in `www/content/docs/shell.mdx`
- [X] T039 Run targeted sync-client tests for parser, clipboard, and attach integration in `packages/sync-client/package.json`
- [X] T040 Run gateway route tests for terminal paste assets in `tests/gateway/shell-routes.test.ts`
- [X] T041 Run repository review gates from `docs/dev/review-pipeline.md`, including `bun run typecheck`, `bun run check:patterns:diff`, and targeted tests
- [X] T042 Prepare backend PR invariants covering source of truth, cleanup/orphan states, auth source of truth, body limits, and deferred scope using `docs/dev/review-pipeline.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies.
- **Phase 2 Foundational**: Depends on Phase 1.
- **Phase 3 User Story 1**: Depends on Phase 2 and is the MVP.
- **Phase 4 User Story 2**: Depends on Phase 2; can start after the shared upload/rewrite seam exists, but should validate alongside US1 to avoid duplicate image intent.
- **Phase 5 User Story 3**: Depends on Phase 2; can be developed in parallel with US1/US2 by another implementer after shared constants and seams exist.
- **Phase 6 Polish**: Depends on completed user stories selected for the release.

### User Story Dependencies

- **US1 (P1)**: No dependency on other stories after Phase 2. Delivers the MVP path-paste behavior.
- **US2 (P2)**: Depends on shared rich paste pipeline from Phase 2 and should remain independently testable with injected clipboard readers.
- **US3 (P3)**: Depends on shared rich paste and paste asset seams from Phase 2. Hardens US1/US2 but has independent failure-mode tests.

### Within Each User Story

- Tests must be written and observed failing before implementation tasks.
- Local parser/service tasks precede attach-loop integration.
- Gateway route tests precede gateway route implementation.
- Each story must pass its own targeted tests before the next priority story is considered complete.

## Parallel Opportunities

- **Setup**: T002 can run in parallel with T001.
- **Foundational**: T003, T004, and T005 can run in parallel after T001.
- **US1**: T009 and T010 can run in parallel; T012 and T014 can run in parallel after tests fail; T015 waits for T014; T017 waits for T012, T013, and T016.
- **US2**: T019 and T020 can run in parallel; T021 and T022 can run in parallel after tests fail; T024 waits for T021-T023.
- **US3**: T026 and T027 can run in parallel; T029 and T031 can run in parallel after tests fail; T034 waits for T033.
- **Polish**: T036, T037, and T038 can run in parallel after the user-facing behavior is stable.

## Parallel Example: User Story 1

```text
Task: "T009 [P] [US1] Add failing gateway contract tests for successful multipart image upload and server-generated paths in tests/gateway/shell-routes.test.ts"
Task: "T010 [P] [US1] Add failing parser tests for quoted paths with spaces, unquoted image paths, non-image path passthrough, multiple image paths, and repeated image dedupe in packages/sync-client/tests/unit/rich-paste.test.ts"
```

## Parallel Example: User Story 2

```text
Task: "T019 [P] [US2] Add failing clipboard reader tests for supported macOS image output, unsupported platform, missing helper, empty clipboard, and timeout in packages/sync-client/tests/unit/clipboard-image.test.ts"
Task: "T020 [P] [US2] Add failing observable paste tests for bracketed paste boundaries and image-only clipboard fallback in packages/sync-client/tests/unit/shell-client.test.ts"
```

## Parallel Example: User Story 3

```text
Task: "T026 [P] [US3] Add failing local validation tests for unreadable, missing, unsupported, oversized, symlink, and upload-failure cases in packages/sync-client/tests/unit/rich-paste.test.ts"
Task: "T027 [P] [US3] Add failing gateway tests for bodyLimit, invalid session name, invalid image type, too many assets, oversized asset, generic error response, and temp cleanup in tests/gateway/shell-routes.test.ts"
```

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 only.
3. Validate that embedded local image paths inside larger pasted prompts upload and rewrite correctly.
4. Ship or demo US1 before adding clipboard-only image paste.

### Incremental Delivery

1. **US1**: Path paste with text becomes usable and safe enough for the common screenshot prompt.
2. **US2**: Observable clipboard-only image paste adds the more natural macOS paste experience.
3. **US3**: Failure hardening and cleanup make the feature trustworthy under bad inputs and partial failures.
4. **Polish**: Docs and gates make the behavior discoverable and review-ready.

## Graphite Stack Plan

This feature crosses sync-client, gateway, docs, and security boundaries, so keep it as a stacked PR series per `docs/dev/stacked-prs.md`.

- **Stack 1: `feat(cli): scaffold terminal rich paste`**  
  Covers T001-T008. Adds shared types, dependency seams, and lifecycle placeholders without behavior.
- **Stack 2: `feat(terminal): upload pasted image paths`**  
  Covers T009-T018. Delivers MVP US1 with gateway paste assets and local path rewrite.
- **Stack 3: `feat(cli): support clipboard image paste`**  
  Covers T019-T025. Adds observable clipboard-only image paste support.
- **Stack 4: `fix(terminal): harden rich paste failures`**  
  Covers T026-T035. Adds validation, generic errors, no-forward guarantees, and cleanup.
- **Stack 5: `docs(cli): document terminal rich paste`**  
  Covers T036-T042. Updates public docs, runs gates, and prepares PR invariants.

Each stack layer should stay under the review size guidance in `docs/dev/review-pipeline.md`, include `Stack: N/5` in the PR body, and preserve the backend invariants section for layers touching `packages/gateway/`.

## Format Validation

- All task rows use `- [ ] T###` checklist format.
- User story task rows include `[US1]`, `[US2]`, or `[US3]`.
- Parallel markers are only used for tasks that can run independently after their dependencies.
- Every task description includes at least one exact repository file path.
