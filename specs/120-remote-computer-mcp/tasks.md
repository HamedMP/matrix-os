# Tasks: Remote Computer MCP

**Input**: Design documents from `specs/120-remote-computer-mcp/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/tools.md

**Tests**: TDD is mandatory. Each test task must be run and observed failing before its paired implementation task begins.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can be worked independently in a different file after its prerequisites
- **[Story]**: User story from the specification

## Phase 1: Setup

**Purpose**: Establish the distributable protocol dependency and CLI entry point.

- [x] T001 Update the published CLI patch version and add `@modelcontextprotocol/sdk` in `packages/sync-client/package.json`, then refresh `pnpm-lock.yaml` from the repository root
- [x] T002 Add the `mcp` command registration shell without tool implementation in `packages/sync-client/src/cli/commands/mcp.ts` and `packages/sync-client/src/cli/index.ts`

---

## Phase 2: Foundational boundary

**Purpose**: Shared validation, safe errors, profile auth, computer resolution, and gateway URL construction.

**Critical**: All user stories depend on this phase.

- [x] T003 Write failing boundary/adversarial tests for runtime slots, paths, command argv, base64, byte limits, and safe error projection in `packages/sync-client/tests/unit/mcp-schemas.test.ts`
- [x] T004 Implement strict tool schemas and safe MCP result/error helpers in `packages/sync-client/src/mcp/schemas.ts` and `packages/sync-client/src/mcp/errors.ts`
- [x] T005 Write failing tests for active/explicit profile resolution, expired auth, production control-plane origin, inventory validation, unavailable computers, and query-preserving gateway URLs in `packages/sync-client/tests/unit/mcp-profile-context.test.ts`
- [x] T006 Implement profile/auth loading plus explicit owner-authorized computer resolution in `packages/sync-client/src/mcp/profile-context.ts`
- [x] T007 Write failing HTTP-client tests for authorization headers, request timeouts, response size caps, safe status mapping, and no raw error leakage in `packages/sync-client/tests/unit/mcp-clients.test.ts`
- [x] T008 Implement the shared bounded authenticated request layer in `packages/sync-client/src/mcp/clients.ts`

**Checkpoint**: A scoped runtime can be resolved safely, but no MCP domain tool is registered yet.

---

## Phase 3: User Story 1 - Run work on a chosen Matrix computer (Priority: P1) MVP

**Goal**: Discover authorized computers and run captured argv commands on an explicit computer.

**Independent Test**: With a fake account containing two computers, list both and run `pwd` on the non-default slot; verify only that gateway receives the request and structured completion metadata is returned.

- [x] T009 [US1] Write failing MCP handler tests for `list_computers` and `run_command`, including explicit target, timeout, output truncation metadata, unavailable target, and second-computer token selection in `packages/sync-client/tests/integration/mcp-server.test.ts`
- [x] T010 [US1] Add computer inventory and captured-command methods to `packages/sync-client/src/mcp/clients.ts`
- [x] T011 [US1] Register `list_computers` and `run_command` with correct annotations and safe results in `packages/sync-client/src/mcp/server.ts`
- [x] T012 [US1] Wire stdio transport and profile selection into `packages/sync-client/src/cli/commands/mcp.ts`

**Checkpoint**: The MVP can execute captured work remotely through a real MCP client without using a local shell.

---

## Phase 4: User Story 2 - Work in persistent terminals and tabs (Priority: P1)

**Goal**: Create/list persistent zellij terminals and tabs, select a tab, and send bounded input.

**Independent Test**: Create a terminal and tab through MCP, list them, select the new tab, send `printf ok\n`, and verify the fake gateway receives each request in order.

- [x] T013 [US2] Add failing terminal tool tests for list/create session, list/create/select tab, input size, stale references, and duplicate names in `packages/sync-client/tests/integration/mcp-server.test.ts`
- [x] T014 [US2] Add bounded terminal session/tab/input methods and safe projections in `packages/sync-client/src/mcp/clients.ts`
- [x] T015 [US2] Register six persistent terminal tools with read-only/state-changing annotations in `packages/sync-client/src/mcp/server.ts`

**Checkpoint**: Persistent work is visible and reconnectable through Matrix terminal surfaces.

---

## Phase 5: User Story 3 - Inspect and transfer Matrix files (Priority: P2)

**Goal**: List/read/download/upload bounded content without local filesystem path access.

**Independent Test**: Transfer text and binary fixtures through MCP and reject traversal, protected/invalid paths, invalid base64, oversize content, symlink/not-file responses, and overwrite without consent.

- [x] T016 [US3] Add failing file tool tests for list, UTF-8 read, base64 download/upload, 256 KiB/1 MiB caps, traversal, invalid base64, timeout, and overwrite conflict in `packages/sync-client/tests/integration/mcp-server.test.ts`
- [x] T017 [US3] Add bounded list/blob client methods with content-length and post-read caps in `packages/sync-client/src/mcp/clients.ts`
- [x] T018 [US3] Register `list_files`, `read_file`, `download_file`, and `upload_file` with content-only transfer contracts in `packages/sync-client/src/mcp/server.ts`

**Checkpoint**: Small remote artifacts can move through MCP without granting local path access.

---

## Phase 6: User Story 4 - Check Matrix chat sessions (Priority: P2)

**Goal**: List, search, and inspect canonical chats without mutation.

**Independent Test**: List/search seeded chat summaries and inspect a paginated chat detail; verify every request is GET, limits are capped at 100, and cross-owner/not-found responses are generic.

- [x] T019 [US4] Add failing read-only chat tests for list/search/detail pagination, query encoding, item/message caps, empty chats, and generic not-found in `packages/sync-client/tests/integration/mcp-server.test.ts`
- [x] T020 [US4] Add read-only canonical chat methods and bounded response projection in `packages/sync-client/src/mcp/clients.ts`
- [x] T021 [US4] Register `list_chats`, `search_chats`, and `get_chat` as read-only tools in `packages/sync-client/src/mcp/server.ts`

**Checkpoint**: Agents can recover bounded task context without altering chat state.

---

## Phase 7: User Story 5 - Install one portable Matrix OS plugin (Priority: P3)

**Goal**: Ship the MCP alongside existing Matrix skills through the current plugin.

**Independent Test**: Validate the plugin and assert its MCP config is portable, referenced by the manifest, contains no credentials/absolute paths, and starts the pinned Matrix CLI MCP command.

- [x] T022 [US5] Write failing plugin contract tests for manifest/MCP linkage, command portability, version pinning, and secret/absolute-path rejection in `tests/plugins/matrix-os-plugin.test.ts`
- [x] T023 [US5] Add `plugins/matrix-os/.mcp.json`, bump and update `plugins/matrix-os/.codex-plugin/plugin.json`, and preserve the existing marketplace entry in `.agents/plugins/marketplace.json`
- [x] T024 [US5] Update remote-first MCP guidance with CLI fallback in `plugins/matrix-os/skills/matrix-cloud-run/SKILL.md` and `plugins/matrix-os/skills/matrix-github-project/SKILL.md`
- [x] T025 [US5] Run the plugin creator validator against `plugins/matrix-os` and fix every reported issue in the plugin bundle

---

## Phase 8: Polish and release gates

**Purpose**: Documentation, packaging, security review, and PR delivery.

- [x] T026 Update CLI usage/tool/limit documentation and packaging checks in `packages/sync-client/README.md` and `packages/sync-client/scripts/check-publish.mjs`
- [x] T027 Mark completed work and record exact validation evidence in `specs/120-remote-computer-mcp/tasks.md` and `specs/120-remote-computer-mcp/quickstart.md`
- [x] T028 Run focused CLI tests/build plus `bun run typecheck`, `bun run check:patterns`, and `bun run test`; fix only failures caused by this branch
- [x] T029 Perform the review pipeline mechanical, trust-boundary, and failure-mode sweeps over changed production files and document any intentional deferral in the PR body
- [x] T030 Create the companion public documentation change in `FinnaAI/matrix-os-site/content/docs/` and link its PR from the implementation PR
- [ ] T031 Commit with a Conventional Commit message, push `codex/remote-computer-mcp`, open the implementation PR with the mandatory Invariants section, and run `prcheck` until required checks and Greptile reach the merge gate

---

## Dependencies and Execution Order

### Phase dependencies

- Setup (Phase 1) starts immediately.
- Foundational (Phase 2) depends on Setup and blocks all stories.
- US1 establishes server/transport registration used by later stories.
- US2, US3, and US4 depend on the foundation and server registration; their domain client/test work is otherwise independent.
- US5 depends on the final CLI command/tool names.
- Polish depends on all selected stories.

### User story dependencies

- **US1**: Foundation only; MVP.
- **US2**: Foundation plus MCP server scaffold from US1.
- **US3**: Foundation plus MCP server scaffold from US1.
- **US4**: Foundation plus MCP server scaffold from US1.
- **US5**: Completed public CLI contract from US1-US4.

### Parallel opportunities

- After T008, test design for terminal, file, and chat domains can proceed independently in separate files if later split from the integration suite.
- Plugin contract tests can begin after the final command/tool contract is frozen.
- Public docs can be drafted while the full repository test suite runs, but cannot claim release readiness until validation passes.

## Graphite Stack Plan

This feature is planned as one structured-review PR, not a stack: it changes one published CLI boundary plus its existing plugin, introduces no endpoint or migration, and is expected to remain in the repository's 1,000-3,000-addition / 20-50-file single-PR band. If implementation exceeds 3,000 additions or 50 files, stop before commit and split with Graphite into:

1. CLI MCP foundation + computers/commands/terminals.
2. Files/chats + plugin packaging/documentation.

Do not flatten those branches if the split threshold is crossed.

## Implementation Strategy

1. Complete T001-T008 with observed red/green tests.
2. Complete US1 and validate the MVP independently.
3. Add persistent terminals, then files, then read-only chats with a red/green cycle per story.
4. Freeze the tool contract, wire the plugin, and validate the bundle.
5. Run full gates, structured review, companion docs, and PR workflow.

## Format Validation

- Every executable line uses `- [ ] TNNN`.
- Story tasks include `[USN]`; setup/foundation/polish tasks do not.
- Every task names concrete file paths.
- Test tasks precede implementation tasks for each boundary/story.
