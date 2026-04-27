# Tasks: Zellij-Native Shell and Unified CLI

**Input**: Design documents from `/specs/068-zellij-cli/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Required. The Matrix OS constitution and feature plan require TDD; write failing Vitest/contract tests before implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing. Setup and Foundational phases establish shared infrastructure only.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and does not depend on incomplete tasks
- **[Story]**: Maps to a user story from `spec.md`
- Every task includes an exact target file path

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the feature file layout and align package entry points before test-first implementation begins.

- [X] T001 Create gateway shell module directory and barrel placeholder in `packages/gateway/src/shell/index.ts`
- [X] T002 [P] Create sync-client shell command placeholder in `packages/sync-client/src/cli/commands/shell.ts`
- [X] T003 [P] Create sync-client profile command placeholder in `packages/sync-client/src/cli/commands/profile.ts`
- [X] T004 [P] Create sync-client doctor command placeholder in `packages/sync-client/src/cli/commands/doctor.ts`
- [X] T005 [P] Create sync-client instance command placeholder in `packages/sync-client/src/cli/commands/instance.ts`
- [X] T006 [P] Create CLI and gateway test placeholders in `tests/cli/shell.test.ts` and `tests/gateway/shell-routes.test.ts`
- [X] T007 Verify zellij 0.44.1 is installed in the runtime image and document any Dockerfile change in `Dockerfile`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared validation, zellij process control, owner-file persistence, profile resolution, and response envelopes that all stories rely on.

**CRITICAL**: No user story work can begin until this phase is complete.

### Tests First

- [X] T008 [P] Add failing safe-name and home-path validation tests for sessions, layouts, profiles, and cwd in `tests/gateway/shell-names.test.ts`
- [X] T009 [P] Add failing bounded zellij adapter tests for timeout, argument-array spawning, stderr sanitization, and abort cleanup in `tests/gateway/shell-zellij.test.ts`
- [X] T010 [P] Add failing shell registry tests for atomic writes, session cap rejection, stale zellij reconciliation, and orphan rollback in `tests/gateway/shell-registry.test.ts`
- [X] T011 [P] Add failing layout store tests for size caps, validation temp-file cleanup, atomic save, and previous-file preservation in `tests/gateway/shell-layouts.test.ts`
- [X] T012 [P] Add failing CLI JSON/NDJSON envelope tests for versioned success and generic error output in `tests/cli/json-output.test.ts`
- [X] T013 [P] Add failing profile migration tests for legacy `~/.matrixos/auth.json` and `~/.matrixos/config.json` idempotent migration in `tests/cli/legacy-config-migration.test.ts`
- [X] T014 [P] Add failing daemon envelope schema tests for protocol version, max message size, stable errors, and unknown command behavior in `tests/sync-client/daemon-ipc-v1.test.ts`

### Implementation

- [X] T015 Implement shared shell identifier and path validation helpers in `packages/gateway/src/shell/names.ts`
- [X] T016 Implement bounded zellij control-process adapter with `execFile`/`spawn` argument arrays and AbortSignal timeouts in `packages/gateway/src/shell/zellij.ts`
- [X] T017 Implement owner-file atomic write helper for gateway shell metadata in `packages/gateway/src/shell/atomic-write.ts`
- [X] T018 Implement zellij-backed shell registry with session caps, reconciliation, and atomic metadata persistence in `packages/gateway/src/shell/registry.ts`
- [X] T019 Implement layout storage, bounded validation, temp-file cleanup, and atomic save/delete behavior in `packages/gateway/src/shell/layouts.ts`
- [X] T020 Implement stable gateway shell error mapping and server-side logging helpers in `packages/gateway/src/shell/errors.ts`
- [X] T021 Implement profile model, default cloud/local profiles, active profile resolution, and legacy migration in `packages/sync-client/src/lib/profiles.ts`
- [X] T022 Implement profile-scoped token storage integration in `packages/sync-client/src/auth/token-store.ts`
- [X] T023 Implement versioned CLI human/JSON/NDJSON output helpers with generic error envelopes in `packages/sync-client/src/cli/output.ts`
- [X] T024 Implement shared CLI profile/global flag resolution for `--profile`, `--dev`, `--platform`, `--gateway`, and `--token` in `packages/sync-client/src/cli/profiles.ts`
- [X] T025 Implement daemon v1 request/response/error schemas and command allowlist in `packages/sync-client/src/daemon/types.ts`

**Checkpoint**: Foundation ready. Gateway shell modules, CLI profiles/output, and daemon envelopes are testable without any complete user story.

---

## Phase 3: User Story 1 - Resume The Same Terminal Everywhere (Priority: P1) MVP

**Goal**: Users can create a named zellij session, detach, and reattach from browser, CLI, or editor-facing data plane without duplicate sessions or lost recent output.

**Independent Test**: Create a named session from one surface, attach from another, disconnect, reconnect with replay, and verify the same live session state and output are visible.

### Tests for User Story 1

- [X] T026 [P] [US1] Add failing REST contract tests for `GET /api/sessions`, `POST /api/sessions`, and `DELETE /api/sessions/:name` in `tests/gateway/shell-routes.test.ts`
- [X] T027 [P] [US1] Add failing WebSocket attach/replay tests for `/ws/terminal?session=<name>&fromSeq=<n>`, short-lived token auth, bearer auth, and constant-time token comparison in `tests/gateway/terminal-zellij-ws.test.ts`
- [X] T028 [P] [US1] Add failing bounded replay-buffer tests for output sequence, replay markers, eviction, and reuse/adaptation of `packages/gateway/src/ring-buffer.ts` behavior in `tests/gateway/shell-replay-buffer.test.ts`
- [X] T029 [P] [US1] Add failing CLI shell session tests for `matrix shell ls`, `new`, `attach`, and `rm` JSON output in `tests/cli/shell.test.ts`

### Implementation for User Story 1

- [X] T030 [US1] Implement session list/create/delete route handlers with auth, bodyLimit, validation, and generic errors in `packages/gateway/src/shell/routes.ts`
- [X] T031 [US1] Register zellij session REST routes and verify dependencies at startup in `packages/gateway/src/server.ts`
- [X] T032 [US1] Implement shell replay wrapper with sequence tracking by reusing/adapting `packages/gateway/src/ring-buffer.ts` in `packages/gateway/src/shell/replay-buffer.ts`
- [X] T033 [US1] Implement zellij WebSocket attach handler with browser token auth, bearer auth, constant-time token comparison, resize/input/detach handling, and process cleanup in `packages/gateway/src/shell/ws.ts`
- [X] T034 [US1] Register `/ws/terminal?session=<name>` zellij attach path while preserving deprecated raw PTY compatibility in `packages/gateway/src/server.ts`
- [X] T035 [US1] Implement shell session client methods for REST and WS attach in `packages/sync-client/src/cli/shell-client.ts`
- [X] T036 [US1] Implement `matrix shell ls`, `matrix shell new`, `matrix shell attach`, and `matrix shell rm` in `packages/sync-client/src/cli/commands/shell.ts`
- [X] T037 [US1] Wire the shell command namespace and `matrix sh` alias into the published CLI command tree in `packages/sync-client/src/cli/index.ts`

**Checkpoint**: User Story 1 works independently as the MVP session foundation.

---

## Phase 4: User Story 2 - Use One Cloud-First CLI (Priority: P1)

**Goal**: The published `matrix` CLI handles login, profiles, identity, status, diagnostics, instance operations, shell access, and local development targeting without competing command sets.

**Independent Test**: Install or run the CLI, log in with cloud or local profile, inspect identity/status, switch per command, and perform shell/session operations without using an old development CLI.

### Tests for User Story 2

- [X] T038 [P] [US2] Add failing profile command tests for `profile ls`, `show`, `use`, and `set` in `tests/cli/profile.test.ts`
- [X] T039 [P] [US2] Add failing login/logout/whoami/status and profile-aware sync command tests for active profile, per-command `--profile`, and `--dev` behavior in `tests/cli/profile-auth.test.ts`
- [X] T040 [P] [US2] Add failing old CLI redirect/removal tests for development-only command drift in `tests/cli/unified-command-tree.test.ts`
- [X] T041 [P] [US2] Add failing instance command tests for `instance info`, `restart`, and `logs` generic error output in `tests/cli/instance.test.ts`

### Implementation for User Story 2

- [X] T042 [US2] Implement profile CRUD and active-profile commands in `packages/sync-client/src/cli/commands/profile.ts`
- [X] T043 [US2] Update login command to use profile-scoped platform/gateway URLs and `--dev` local profile targeting in `packages/sync-client/src/cli/commands/login.ts`
- [X] T044 [US2] Update logout command to clear profile-scoped auth without touching other profiles in `packages/sync-client/src/cli/commands/logout.ts`
- [X] T045 [US2] Implement `matrix whoami` and profile-aware identity output in `packages/sync-client/src/cli/commands/whoami.ts`
- [X] T046 [US2] Implement profile-aware `matrix status` using stable JSON output in `packages/sync-client/src/cli/commands/status.ts`
- [X] T047 [US2] Implement profile-aware instance info/restart/logs commands with bounded fetch timeouts and generic errors in `packages/sync-client/src/cli/commands/instance.ts`
- [X] T048 [US2] Remove or redirect old development-only CLI entry points to the published command tree in `packages/cli/src/index.ts`
- [X] T049 [US2] Register profile, whoami, status, doctor, instance, completion, shell, and profile-aware sync namespaces in `packages/sync-client/src/cli/index.ts` and `packages/sync-client/src/cli/commands/sync.ts`

**Checkpoint**: User Story 2 works independently with one cloud-first CLI and profile model.

---

## Phase 5: User Story 3 - Manage Sessions, Tabs, Panes, And Layouts (Priority: P2)

**Goal**: Users can script and repeat terminal workspaces with first-class session, tab, pane, and layout operations.

**Independent Test**: Use CLI commands to create a session, add tabs, split panes, save a layout, apply it to a later session, and remove the session.

### Tests for User Story 3

- [X] T050 [P] [US3] Add failing REST contract tests for tab list/create/switch/close operations with auth, ownership checks, bodyLimit on mutating routes, validation, and generic errors in `tests/gateway/shell-tabs.test.ts`
- [X] T051 [P] [US3] Add failing REST contract tests for pane split/close operations with auth, ownership checks, bodyLimit, cwd/cmd validation, and generic errors in `tests/gateway/shell-panes.test.ts`
- [X] T052 [P] [US3] Add failing REST contract tests for layout list/show/save/apply/delete and dump operations with auth, ownership checks, bodyLimit, validation, and generic errors in `tests/gateway/shell-layout-routes.test.ts`
- [X] T053 [P] [US3] Add failing CLI tests for `matrix shell tab`, `pane`, and `layout` command namespaces in `tests/cli/shell-workspace.test.ts`

### Implementation for User Story 3

- [X] T054 [US3] Implement tab list/create/go/close zellij operations and route handlers with auth, ownership checks, bodyLimit, validation, and generic errors in `packages/gateway/src/shell/routes.ts`
- [X] T055 [US3] Implement pane split/close zellij operations and route handlers with auth, ownership checks, bodyLimit, cwd/cmd validation, and generic errors in `packages/gateway/src/shell/routes.ts`
- [X] T056 [US3] Implement layout list/show/save/apply/delete/dump route handlers with auth, ownership checks, bodyLimit, validation, and generic errors in `packages/gateway/src/shell/routes.ts`
- [X] T057 [US3] Extend zellij adapter with tab, pane, layout dump, and layout apply commands in `packages/gateway/src/shell/zellij.ts`
- [X] T058 [US3] Implement CLI tab, pane, and layout subcommands with JSON output and stable errors in `packages/sync-client/src/cli/commands/shell.ts`
- [X] T059 [US3] Add shell layout client methods for REST layout operations in `packages/sync-client/src/cli/shell-client.ts`

**Checkpoint**: User Story 3 works independently for repeatable terminal workspace management.

---

## Phase 6: User Story 4 - Give Editor Integrations A Stable Contract (Priority: P2)

**Goal**: VSCode and future integrations can use a documented, versioned local contract for auth context, shell control, sync status, and direct terminal attach without scraping CLI text or reading internal files.

**Independent Test**: Build a minimal local client that lists sessions, creates a session, resolves auth context, observes sync status, and attaches to terminal data plane using only the documented contract.

### Tests for User Story 4

- [X] T060 [P] [US4] Add failing daemon IPC contract tests for `auth.whoami`, `auth.token`, `auth.refresh`, `shell.list`, `shell.create`, and `shell.destroy` in `tests/sync-client/daemon-ipc-v1.test.ts`
- [X] T061 [P] [US4] Add failing daemon IPC contract tests for tab, pane, layout, and sync v1 aliases in `tests/sync-client/daemon-ipc-v1.test.ts`
- [X] T062 [P] [US4] Add failing local daemon socket permission, max-connection, and buffer-cap tests in `tests/sync-client/daemon-security.test.ts`
- [X] T063 [P] [US4] Add failing minimal editor-client fixture test for contract-only session list/auth/attach flow in `tests/sync-client/daemon-editor-client.test.ts`

### Implementation for User Story 4

- [X] T064 [US4] Implement v1 daemon shell/auth/layout/tab/pane command dispatch in `packages/sync-client/src/daemon/ipc-handler.ts`
- [X] T065 [US4] Implement daemon v1 response envelopes, socket permission checks, connection caps, and buffer caps in `packages/sync-client/src/daemon/ipc-server.ts`
- [X] T066 [US4] Implement daemon auth-context resolution from active profile and profile token store in `packages/sync-client/src/daemon/ipc-handler.ts`
- [X] T067 [US4] Implement daemon-to-gateway shell control client with bounded timeouts and stable error mapping in `packages/sync-client/src/daemon/shell-control-client.ts`
- [X] T068 [US4] Add compatibility aliases for existing sync daemon commands and new `sync.*` command names in `packages/sync-client/src/daemon/ipc-handler.ts`
- [X] T069 [US4] Document the v1 daemon compatibility window and terminal data-plane split in `specs/068-zellij-cli/contracts/daemon-ipc.md`

**Checkpoint**: User Story 4 works independently for local integrations.

---

## Phase 7: User Story 5 - Diagnose And Recover From Common Failures (Priority: P3)

**Goal**: Users get clear recovery guidance for login, daemon, sync, gateway, layout, and session failures without exposing internal implementation details.

**Independent Test**: Simulate expired auth, unavailable services, missing sessions, malformed layouts, incompatible daemon protocol, and interrupted connections; verify stable codes and actionable human guidance.

### Tests for User Story 5

- [X] T070 [P] [US5] Add failing doctor command tests for expired auth, missing daemon, unavailable gateway, and incompatible daemon protocol in `tests/cli/doctor.test.ts`
- [X] T071 [P] [US5] Add failing recovery error tests for missing session, duplicate session, malformed layout, timeout, and reconnect interruption in `tests/cli/shell-recovery.test.ts`
- [X] T072 [P] [US5] Add failing gateway generic-error tests proving raw zellij stderr, stack traces, and filesystem paths are not exposed in `tests/gateway/shell-error-policy.test.ts`

### Implementation for User Story 5

- [X] T073 [US5] Implement `matrix doctor` dependency probes and recovery hints for profile, auth, daemon, gateway, sync, and zellij health in `packages/sync-client/src/cli/commands/doctor.ts`
- [X] T074 [US5] Implement CLI recovery hint mapping for stable shell/profile/daemon error codes in `packages/sync-client/src/cli/recovery-hints.ts`
- [X] T075 [US5] Apply gateway shell error sanitization and structured server-side logs across all shell routes and WebSocket handlers in `packages/gateway/src/shell/errors.ts`
- [X] T076 [US5] Add reconnect, stale daemon, and incompatible protocol handling to daemon client calls in `packages/sync-client/src/cli/daemon-client.ts`

**Checkpoint**: User Story 5 works independently for diagnosis and recovery.

---

## Phase 8: User Story 6 - Browser Shell Parity With Modern Terminals (Priority: P2)

**Goal**: Bring the browser shell to ghostty/warp-class polish: per-session font/ligatures/cursor/theme preferences, inline image rendering, durable file-backed scrollback, OSC 133 command-block awareness, and richer link detection — without breaking the zellij-native session contract from US1.

**Independent Test**: Open a session, change font and theme through the preferences UI, run a command that emits an inline image, scroll back beyond the hot buffer, and copy a single command block via the block-aware shortcut. Detach, reattach from another surface, confirm preferences and scrollback persist.

### Tests for User Story 6

- [X] T085 [P] [US6] Add failing OSC 133 streaming parser tests (semantic marks A/B/C/D, exit-code variant, partial-chunk reassembly across writes, malformed sequence safety, byte-pass-through invariant) in `tests/gateway/shell-osc133-parser.test.ts`
- [X] T086 [P] [US6] Add failing file-backed scrollback store tests (atomic appends, bounded per-session size, replay-from-seq across hot/cold boundary, cleanup on session delete, recovery after gateway restart) in `tests/gateway/shell-scrollback-store.test.ts`
- [X] T087 [P] [US6] Add failing per-session preferences tests (Zod schema, GET/PUT route auth + bodyLimit + validation, atomic persistence, restore on attach) in `tests/gateway/shell-preferences.test.ts`
- [X] T088 [P] [US6] Add failing image-protocol passthrough tests (sixel and iTerm2 inline-image escape sequences survive replay byte-for-byte) in `tests/gateway/shell-image-passthrough.test.ts`
- [X] T089 [P] [US6] Add failing shell component tests for preferences panel (theme picker, font selector, ligatures toggle, cursor style, smooth scroll) in `shell/src/components/terminal/__tests__/preferences-panel.test.tsx`
- [X] T090 [P] [US6] Add failing web-link-provider tests for commit SHA, `#issue` reference, and `npm:`/`pnpm:` package specifier detection in `shell/src/components/terminal/__tests__/web-link-provider.test.ts`

### Implementation for User Story 6

- [X] T091 [US6] Implement OSC 133 streaming parser with partial-chunk reassembly and bounded pending buffer in `packages/gateway/src/shell/osc133.ts`
- [X] T092 [US6] Wire OSC 133 parser into replay buffer to emit `block-mark` events alongside `output` events without modifying the byte stream in `packages/gateway/src/shell/replay-buffer.ts`
- [X] T093 [US6] Implement file-backed scrollback store with append-only per-session file, bounded per-session size cap, and atomic rotation in `packages/gateway/src/shell/scrollback-store.ts`
- [X] T094 [US6] Update `ShellReplayBuffer` to serve replay-from-seq from in-memory hot tail then archive cold tail with a single ordered stream in `packages/gateway/src/shell/replay-buffer.ts`
- [X] T095 [US6] Add scrollback file cleanup to session delete and stale-session reconciliation paths in `packages/gateway/src/shell/registry.ts`
- [X] T096 [US6] Implement per-session preferences schema, store, and atomic persistence in `packages/gateway/src/shell/preferences.ts`
- [X] T097 [US6] Add `GET /api/sessions/:name/preferences` and `PUT /api/sessions/:name/preferences` route handlers with auth, bodyLimit, validation, and generic errors in `packages/gateway/src/shell/routes.ts`
- [X] T098 [P] [US6] Mount `@xterm/addon-image` for sixel/iTerm2 inline images and bundle Berkeley Mono / JetBrains Mono / Fira Code font assets in `shell/src/components/terminal/TerminalPane.tsx`
- [X] T099 [P] [US6] Implement preferences panel UI (theme picker, font selector, ligatures toggle, cursor style, smooth scroll) wired to the new gateway route in `shell/src/components/terminal/preferences-panel.tsx`
- [X] T100 [P] [US6] Apply per-session preferences on attach and render OSC 133 block boundaries with a copy-block keyboard shortcut in `shell/src/components/terminal/TerminalApp.tsx` and `shell/src/components/terminal/TerminalPane.tsx`
- [X] T101 [P] [US6] Extend link provider with commit SHA, issue reference, and package specifier patterns in `shell/src/components/terminal/web-link-provider.ts`
- [X] T102 [US6] Update gateway shell module barrel to export `osc133`, `scrollback-store`, and `preferences` in `packages/gateway/src/shell/index.ts`
- [X] T103 [US6] Rerun pattern scanner and three-pass trust-boundary review on US6 HTTP, persistence, and link-handling surfaces using `scripts/review/check-patterns.sh` and `docs/dev/review-pipeline.md`

**Checkpoint**: Browser shell reaches feature parity with modern native terminals on fonts/ligatures/themes/images/scrollback/blocks while preserving the zellij session contract.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Public docs, compatibility cleanup, review gates, and quickstart validation that cut across all user stories.

- [X] T077 [P] Update public CLI guide with login, profiles, shell sessions, JSON/NDJSON output, and migration guidance in `www/content/docs/guide/cli.mdx`
- [X] T078 [P] Update public docs navigation for CLI guide changes in `www/content/docs/guide/meta.json`
- [X] T079 [P] Add migration and troubleshooting notes for old CLI users in `www/content/docs/guide/integrations.mdx`
- [X] T080 Validate quickstart flows and update any stale commands in `specs/068-zellij-cli/quickstart.md`
- [X] T081 Run and fix pattern scanner findings, then complete the three-pass trust-boundary/security review for every new HTTP, WebSocket, CLI, and IPC surface using `scripts/review/check-patterns.sh` and `docs/dev/review-pipeline.md`
- [X] T082 Run and fix focused tests for CLI, gateway shell routes, zellij WS, and daemon IPC in `tests/cli/shell.test.ts`, `tests/gateway/shell-routes.test.ts`, `tests/gateway/terminal-zellij-ws.test.ts`, and `tests/sync-client/daemon-ipc-v1.test.ts`
- [X] T083 Run and fix repository typecheck issues caused by the feature in `package.json`
- [ ] T084 Run and fix full unit test regressions caused by the feature in `package.json`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational. This is the MVP.
- **User Story 2 (Phase 4)**: Depends on Foundational and can proceed in parallel with US1 after shared profile/output helpers exist, but shell command validation benefits from US1.
- **User Story 3 (Phase 5)**: Depends on Foundational and the session create/attach model from US1.
- **User Story 4 (Phase 6)**: Depends on Foundational and can use US1/US3 shell clients as they land.
- **User Story 5 (Phase 7)**: Depends on Foundational and should run after at least US1 and US2 error surfaces exist.
- **User Story 6 (Phase 8)**: Depends on Foundational and on US1's session create/attach and replay buffer; can run in parallel with US3/US4/US5 since it touches shell-side rendering, scrollback persistence, and a new preferences route.
- **Polish (Phase 9)**: Depends on all desired user stories for the release scope.

### User Story Dependencies

- **US1 (P1)**: Start after Phase 2. No dependency on other stories.
- **US2 (P1)**: Start after Phase 2. Independent profile/status work can run before US1, but final shell namespace validation uses US1.
- **US3 (P2)**: Start after US1 because tabs, panes, and layouts operate inside named sessions.
- **US4 (P2)**: Start after Phase 2; shell command coverage integrates with US1 and US3 as those APIs land.
- **US5 (P3)**: Start after error-producing surfaces exist in US1 through US4.
- **US6 (P2)**: Start after US1's replay buffer and session metadata exist. OSC 133 parser, scrollback store, and preferences route are independent of US3/US4/US5.

### Within Each User Story

- Write tests first and verify they fail.
- Implement schema/model helpers before services.
- Implement services before route, daemon, or CLI command wiring.
- Complete the story checkpoint before moving to the next priority unless work is intentionally parallelized.

## Parallel Opportunities

- Setup placeholders T002 through T006 can run in parallel.
- Foundational tests T008 through T014 can run in parallel.
- Foundational implementation can split by package: gateway shell helpers T015 through T020, CLI profile/output T021 through T024, daemon schemas T025.
- US1 tests T026 through T029 can run in parallel; implementation can split gateway T030 through T034 and CLI T035 through T037 after tests exist.
- US2 tests T038 through T041 can run in parallel; commands T042 through T047 can split by command file.
- US3 tests T050 through T053 can run in parallel; gateway route work T054 through T057 and CLI work T058 through T059 can split after shared contracts are fixed.
- US4 tests T060 through T063 can run in parallel; daemon server/security T065 can proceed alongside command dispatch T064 when schemas are stable.
- US5 tests T070 through T072 can run in parallel; CLI recovery T073/T074 can proceed alongside gateway error policy T075.
- US6 tests T085 through T090 can run in parallel; gateway work T091 through T097 splits cleanly from shell work T098 through T101 since the protocol additions (block-mark events, preferences route) are the only contract surface.

## Parallel Example: User Story 1

```bash
Task: "T026 [US1] Add failing REST contract tests in tests/gateway/shell-routes.test.ts"
Task: "T027 [US1] Add failing WebSocket attach/replay tests in tests/gateway/terminal-zellij-ws.test.ts"
Task: "T028 [US1] Add failing bounded replay-buffer tests in tests/gateway/shell-replay-buffer.test.ts"
Task: "T029 [US1] Add failing CLI shell session tests in tests/cli/shell.test.ts"
```

## Parallel Example: User Story 2

```bash
Task: "T038 [US2] Add failing profile command tests in tests/cli/profile.test.ts"
Task: "T039 [US2] Add failing login/logout/whoami/status tests in tests/cli/profile-auth.test.ts"
Task: "T041 [US2] Add failing instance command tests in tests/cli/instance.test.ts"
```

## Parallel Example: User Story 3

```bash
Task: "T050 [US3] Add failing tab route tests in tests/gateway/shell-tabs.test.ts"
Task: "T051 [US3] Add failing pane route tests in tests/gateway/shell-panes.test.ts"
Task: "T052 [US3] Add failing layout route tests in tests/gateway/shell-layout-routes.test.ts"
Task: "T053 [US3] Add failing CLI workspace tests in tests/cli/shell-workspace.test.ts"
```

## Parallel Example: User Story 4

```bash
Task: "T060 [US4] Add failing auth/shell daemon IPC tests in tests/sync-client/daemon-ipc-v1.test.ts"
Task: "T062 [US4] Add failing daemon security tests in tests/sync-client/daemon-security.test.ts"
Task: "T063 [US4] Add failing editor-client fixture test in tests/sync-client/daemon-editor-client.test.ts"
```

## Parallel Example: User Story 5

```bash
Task: "T070 [US5] Add failing doctor tests in tests/cli/doctor.test.ts"
Task: "T071 [US5] Add failing recovery error tests in tests/cli/shell-recovery.test.ts"
Task: "T072 [US5] Add failing gateway generic-error tests in tests/gateway/shell-error-policy.test.ts"
```

## Parallel Example: User Story 6

```bash
Task: "T085 [US6] Add failing OSC 133 streaming parser tests in tests/gateway/shell-osc133-parser.test.ts"
Task: "T086 [US6] Add failing file-backed scrollback store tests in tests/gateway/shell-scrollback-store.test.ts"
Task: "T087 [US6] Add failing per-session preferences tests in tests/gateway/shell-preferences.test.ts"
Task: "T088 [US6] Add failing image-protocol passthrough tests in tests/gateway/shell-image-passthrough.test.ts"
Task: "T089 [US6] Add failing preferences panel tests in shell/src/components/terminal/__tests__/preferences-panel.test.tsx"
Task: "T090 [US6] Add failing web-link-provider tests in shell/src/components/terminal/__tests__/web-link-provider.test.ts"
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Stop and validate the independent test: create a named session, attach from another surface, disconnect, reconnect, and verify no duplicate session is created.
5. Demo or review the MVP before expanding to CLI profile consolidation and workspace management.

### Incremental Delivery

1. Deliver Setup + Foundational.
2. Deliver US1 for durable shared terminal sessions.
3. Deliver US2 for one cloud-first CLI.
4. Deliver US3 for tabs, panes, and layouts.
5. Deliver US4 for daemon/editor integration contracts.
6. Deliver US5 for diagnostics and recovery.
7. Deliver US6 for browser shell parity (fonts/themes/images/scrollback/blocks).
8. Deliver Polish for documentation and release gates.

### Parallel Team Strategy

1. One engineer owns gateway shell foundation in `packages/gateway/src/shell/`.
2. One engineer owns CLI/profile/output foundation in `packages/sync-client/src/cli/` and `packages/sync-client/src/lib/`.
3. One engineer owns daemon IPC in `packages/sync-client/src/daemon/`.
4. After Phase 2, split by user story while keeping shared contract changes reviewed centrally.

## Notes

- Do not introduce unbounded maps, buffers, child processes, fetches, or IPC waits.
- Do not expose raw zellij stderr, filesystem paths, stack traces, token details, or provider/internal names to clients.
- Mutating gateway routes must use Hono `bodyLimit` before body parsing.
- Persistent shell metadata and layouts must use atomic write-temp-then-rename behavior.
- Use `zod/v4` schemas for request, response, daemon, and CLI JSON contracts.
- Run `pnpm install` from repo root if any dependency is added or removed.
