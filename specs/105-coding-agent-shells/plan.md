# Implementation Plan: Coding Agent Shells

**Status**: Original product model confirmed; Full Workspace Gate B0 awaiting confirmation
**Created**: 2026-07-06
**Planning horizon**: Incremental PR series, not a single mega-branch.

## Summary

This plan upgrades Matrix OS desktop and mobile into first-class coding-agent interfaces while preserving current behavior. The sequence intentionally starts with contracts and read-only projections, then adds agent thread creation, streaming, approvals, terminal binding, review, preview, and notification polish.

The guiding rule is simple: build shared runtime primitives first, then render them differently per shell. The clarified final experience is project-first: one visible chat/session is one resumable `AgentThread`, each message is one server-side `AgentTurn`, and one task may own several independent threads. Desktop and mobile expose Conversation and Kanban views over that same runtime model.

## Strategic Choices

### Choice 1 - Shared Runtime Contracts First

Start with shared schemas before UI work.

Why:

- Desktop, mobile, browser shell, CLI, and gateway need the same vocabulary.
- Contract tests prevent drift between clients.
- Read-only rollout lets us verify state shape before mutating runtime behavior.

How:

- Add or expand a schema-only contract module/package.
- Keep Zod 4 schemas close to gateway route validation.
- Export inferred types for clients.
- Add parse/reject tests before any UI imports the schemas.

### Choice 2 - Runtime Summary As First Integration Point

Add a safe `RuntimeSummary` projection before thread creation.

Why:

- It gives every shell one hydration path.
- It makes feature availability explicit.
- It prevents clients from calling many ad hoc endpoints at startup.
- It provides a compatibility bridge while deeper thread/review APIs mature.

Summary should include:

- Selected runtime.
- Capabilities.
- Provider status.
- Projects/tasks overview.
- Active threads.
- Terminal sessions.
- Recent activity.
- Limits.
- Server time.

Summary must not include:

- Terminal output.
- File contents.
- Thread transcript bodies beyond bounded summaries.
- Provider raw logs.
- Tokens.
- Internal hostnames.
- Raw errors.

### Choice 3 - Thin Clients, Strong Reducers

Clients should render runtime state with pure reducers and bounded caches.

Why:

- Agent streams are event-heavy and reconnect-prone.
- Mobile suspension and desktop sleep/wake are normal.
- Idempotent reducers make replay safe.

Pattern:

- Gateway streams typed events.
- Client parses and reduces events.
- Reducers ignore duplicate event IDs.
- Reducers tolerate unknown event types.
- Reducers cap transcript/tool arrays.
- Client fetches snapshots when cursors are stale.

### Choice 4 - Terminal Sessions Stay Canonical

Do not create a parallel terminal model for agent threads.

Why:

- Matrix already has named shell sessions.
- CLI, web terminal, mobile, and desktop should attach to the same sessions.
- Thread-to-terminal binding can be metadata, not a duplicate process model.

Pattern:

- `TerminalSession` is remote process state.
- `TerminalAttachment` is a client connection.
- Detach does not kill the process.
- Terminate is an explicit user action.
- Attachments support replay/cursor or a compatibility equivalent.

### Choice 5 - Native Desktop Trust Boundary

Desktop main/preload remain the trusted boundary.

Why:

- Renderer can be compromised like any web surface.
- Embedded apps and hosted shell content must never see privileged APIs.
- Credentials belong in OS-encrypted trusted core storage.

Pattern:

- Trusted core owns credential and bearer injection.
- Renderer calls validated IPC/preload APIs.
- IPC schemas validate request and response.
- Notification/deep-link payloads only focus UI after validation.

### Choice 6 - Mobile SDK 57 First, Native Terminal Later

Preserve the current mobile terminal and add native terminal behind capability detection only after a spike.

Why:

- Mobile is on Expo SDK 57 in this branch.
- Existing terminal behavior must not regress.
- Native modules require dev-client/device validation.

Pattern:

- Phase 1 keeps WebView terminal fallback.
- Improve state, parser, reconnect, and thread binding first.
- Add native renderer as optional capability after spike.
- Keep fallback until native is proven across required devices.

### Choice 7 - One Chat Is One Resumable Thread

Do not model each prompt as a new thread.

Why:

- Users reason about a visible chat/session as one agent conversation.
- Provider resume state, approvals, transcript, terminal binding, and review context must remain isolated per chat.
- Creating a replacement thread for a follow-up breaks navigation and cross-shell continuity.

Pattern:

- Thread create accepts the first message and creates the provider conversation.
- `POST /api/coding-agents/threads/:threadId/turns` accepts later messages idempotently.
- The runtime stores provider resume identity; shells receive only safe thread/turn/event projections.
- One normal turn runs at a time per thread. Busy submissions fail safely rather than entering an invisible client queue.

### Choice 8 - Canonical Tasks Own Many Threads

Reuse existing Matrix projects/tasks and Kanban status instead of creating an agent-only board.

Why:

- The desktop already has canonical project task routes and `todo`, `running`, `waiting`, `blocked`, `complete`, `archived` states.
- A task can need separate planning, implementation, review, and repair conversations.
- A singular task-session link cannot represent multi-agent work.

Pattern:

- New threads require `projectId` and optionally reference one task in that project.
- Project workspace read models join canonical task summaries with bounded coding-thread aggregates.
- Task writes remain on canonical task routes.
- Thread status renders as task-card badges/attention and never silently moves the task.

### Choice 9 - Conversation And Kanban Are Views, Not Stores

Both modes consume the same project/task/thread projections.

Why:

- Switching modes must preserve identity and avoid state drift.
- Desktop needs dense project/session navigation while mobile needs route-based phone ergonomics.
- Runtime ownership stays independent of either renderer.

Pattern:

- Persist only selected runtime/project/task/thread and view mode as bounded safe references.
- Reconcile those references on hydration and runtime switch.
- Conversation view focuses one thread and contextual tools.
- Kanban view focuses canonical tasks and bounded thread aggregates; opening a thread returns to the same conversation identity.

## Phase Roadmap

Phases A-H describe the landed/checkpoint foundation and remain required regression context. Phases I-M began after Gate 0 received explicit product-owner confirmation. The later Full Workspace expansion remains separately gated by Gate B0.

### Phase A - Foundation

Scope:

- Current-state inventory.
- Feature flag plan.
- Shared contracts.
- Runtime summary route.
- Provider registry read path.
- Terminal session summary adapter.

Exit criteria:

- Contract tests pass.
- Runtime summary returns bounded safe payload.
- No desktop/mobile UI changes required.
- No existing route behavior changes.

Primary PRs:

1. `contracts(agent-shells): add coding-agent schemas`
2. `feat(gateway): expose coding-agent runtime summary`

### Phase B - Read-Only Shells

Scope:

- Desktop read-only agent dashboard.
- Mobile read-only recent work/agent dashboard.
- Runtime status, providers, active threads, terminal sessions, recent activity.
- Safe empty/offline/setup-required states.

Exit criteria:

- Desktop and mobile hydrate from the same summary.
- Existing desktop and mobile features still pass regression checks.
- Feature flags can disable new UI.

Primary PRs:

1. `feat(desktop): add read-only agent workspace`
2. `feat(mobile): add read-only agent workspace`

### Phase C - Thread Lifecycle

Scope:

- Thread store.
- Thread create route.
- Thread event append/replay.
- Thread WebSocket.
- Fake provider adapter tests.
- First real provider adapter behind flag.

Exit criteria:

- Threads can be created idempotently.
- Events replay and stream.
- Clients can show live thread detail.
- Abort works for one thread without affecting others.

Primary PRs:

1. `feat(gateway): add agent thread store and event stream`
2. `feat(agents): connect first provider adapter`
3. `feat(desktop): create and follow agent threads`
4. `feat(mobile): create and follow agent threads`

### Phase D - Approvals And Input

Scope:

- Approval request events.
- Approval decision route.
- User input answer route.
- Desktop approval UI.
- Mobile approval UI.
- Attention state.

Exit criteria:

- Approval can be resolved from either shell.
- Duplicate/racing decisions are idempotent.
- All shells see resolved state.
- User-facing copy is safe.

Primary PRs:

1. `feat(agents): add approval lifecycle`
2. `feat(desktop): handle agent approvals`
3. `feat(mobile): handle agent approvals`

### Phase E - Terminal Binding

Scope:

- Thread-to-terminal binding.
- Terminal panel in desktop workspace.
- Thread terminal route in mobile.
- Cross-shell attach/resume tests.
- Replay gap and fatal session error handling.

Exit criteria:

- Desktop-created session can be attached from mobile.
- Mobile-created session can be attached from desktop.
- Detach does not kill process.
- Termination updates all shells.

Primary PRs:

1. `feat(gateway): bind terminal sessions to agent threads`
2. `feat(desktop): add workspace terminal panel`
3. `feat(mobile): add thread terminal route`

### Phase F - Files And Review

Scope:

- File browse/search/read/write contracts.
- Conflict-safe saves.
- Review snapshot/diff service.
- Desktop review panel.
- Mobile review route.
- Ask-agent-follow-up action with structured references.

Exit criteria:

- Agent changes are visible as review snapshots.
- Large diffs do not freeze clients.
- File writes detect conflicts.
- Follow-up prompts reference structured file/hunk context.

Primary PRs:

1. `feat(gateway): add agent workspace file and review APIs`
2. `feat(desktop): add review panel`
3. `feat(mobile): add review screens`

### Phase G - Preview And App Runtime

Scope:

- Preview capability in runtime summary.
- Safe preview session metadata.
- Desktop preview panel using existing embed isolation.
- Mobile preview route.
- App/session launch handoff reuse.

Exit criteria:

- Preview origins are validated.
- Embedded auth failure does not destroy native sign-in.
- Existing app launch remains intact.

Primary PRs:

1. `feat(gateway): expose safe workspace previews`
2. `feat(desktop): add preview panel`
3. `feat(mobile): add preview route`

### Phase H - Native Quality And Polish

Scope:

- Desktop command palette and keyboard flow.
- Desktop workspace layout persistence/LRU.
- Mobile recent work home polish.
- Mobile ergonomics.
- Notification routing.
- Native mobile terminal spike and optional rollout.

Exit criteria:

- Desktop is keyboard-first for core agent workflows.
- Mobile can manage daily agent work from phone.
- Notifications route to exact thread/task/session.
- Native terminal lands only if fallback remains and device validation passes.

Primary PRs:

1. `feat(desktop): polish agent mission control`
2. `feat(mobile): polish agent daily workflow`
3. `feat(notifications): route coding-agent attention`
4. `feat(mobile): add native terminal capability`

### Phase I - Product Model And Project Read Models

Scope:

- Product-owner confirmation of the hierarchy and interaction rules.
- Project/task/thread/turn contracts and schema tests.
- Real canonical project summary adapter.
- Bounded project workspace projection with task/thread aggregates.
- Owner/project/task relation validation.

Exit criteria:

- Confirmation gate is recorded before implementation starts.
- Runtime summary returns actual projects when they exist.
- One task can project several threads without nested unbounded arrays.
- Cross-project task bindings are rejected.

Primary PRs:

1. `docs(agent-shells): define project conversation model`
2. `contracts(agent-shells): add project task and turn schemas`
3. `feat(gateway): hydrate project agent workspaces`

### Phase J - Same-Thread Conversation Turns

Scope:

- Idempotent turn mutation and event contracts.
- Atomic active-turn ownership.
- Provider resume support through normalized adapters.
- Desktop/mobile trusted clients.

Exit criteria:

- Two sequential messages remain in one thread/provider conversation.
- Duplicate turn retries return the original accepted turn.
- Concurrent normal turns fail with a safe busy state.
- Abort/failure releases active-turn ownership without affecting other threads.

Primary PRs:

1. `feat(agents): add resumable conversation turns`
2. `feat(desktop): send same-thread follow-ups`
3. `feat(mobile): send same-thread follow-ups`

### Phase K - Desktop Project Conversation And Kanban

Scope:

- Persistent project/task/thread navigator.
- Conversation/Kanban segmented mode.
- Task cards with bounded multi-thread aggregates.
- Same-thread composer and contextual inspector.
- Selection reconciliation and keyboard paths.

Exit criteria:

- Project-level and task-bound chats are visible in the navigator.
- A task with multiple threads exposes every thread independently.
- Mode switching preserves valid project/task/thread selection.
- Existing Board, Terminal, Chat, Apps, Settings, auth, embeds, updater, and menus regressions pass.

Primary PRs:

1. `feat(desktop): add project conversation navigator`
2. `feat(desktop): integrate agent Kanban mode`

### Phase L - Mobile Project Conversation And Kanban

Scope:

- Project-first route hierarchy.
- Task groups with multiple thread rows.
- Phone/tablet Conversation/Kanban mode.
- Same-thread composer and safe resume-state reconciliation.

Exit criteria:

- Mobile can select every thread attached to a task.
- Kanban uses canonical task columns and preserves selected context.
- Background/resume rehydrates project/task/thread state before navigation.
- Existing SDK 57 mobile regression and device-smoke gates pass.

Primary PRs:

1. `feat(mobile): add project conversation routes`
2. `feat(mobile): add agent Kanban mode`

### Phase M - Final Cross-Shell Acceptance

Scope:

- Desktop/mobile real-runtime scenario with two projects, one multi-thread task, and sequential turns.
- Conversation/Kanban identity continuity.
- Security/error audit, performance caps, public/internal docs.

Exit criteria:

- Every acceptance case in `acceptance-tests.md` has current evidence.
- No clarified requirement remains represented only by a placeholder adapter or checkpoint dashboard.
- Product owner confirms the final shell behavior after real-device testing.

## Workstream Ownership

### Gateway/Core Workstream

Owns:

- Contracts at route boundary.
- Runtime summary.
- Provider registry.
- Thread store/events.
- Approval lifecycle.
- Terminal binding.
- File/review/preview APIs.
- Safe errors.
- Auth/resource limits.
- Canonical project/task adapters and bounded workspace projections.
- Same-thread turn ownership, idempotency, and provider resume state.

Must coordinate with:

- Kernel provider/session implementation.
- Terminal session reliability.
- Platform auth/runtime routing.
- Public docs.

### Desktop Workstream

Owns:

- Trusted-core runtime client.
- Validated IPC/preload API.
- Agent mission control UI.
- Desktop composer.
- Thread streams.
- Terminal/review/preview panels.
- Notifications/deep links.
- Runtime switch behavior.
- Project/task/thread navigator and Conversation/Kanban modes.

Must preserve:

- Existing auth.
- Existing embeds.
- Existing settings.
- Existing updater.
- Existing menu/window behavior.
- Existing terminal behavior.

### Mobile Workstream

Owns:

- SDK 57 runtime client.
- Mobile agent routes.
- Mobile composer.
- Thread detail.
- Approval UI.
- Thread terminal route.
- Review/files/preview screens.
- Mobile resume state.
- Native terminal spike.
- Project-first routes, multi-thread task groups, and Conversation/Kanban modes.

Must preserve:

- Existing chat.
- Existing terminal tab.
- Existing apps tab.
- Existing mission control.
- Existing canvas entry.
- Existing settings.
- Existing auth/push/offline behavior.

### Shell/CLI Workstream

Owns:

- Browser shell parity where needed.
- Canvas/Desktop built-in route wiring.
- CLI compatibility for terminal/session operations.
- Shared contracts usage.

Must preserve:

- Canvas as primary browser shell.
- Terminal built-in route behavior.
- App launcher/app runtime behavior.

## Decision Gates

### Gate 0 - Product Model Confirmation

**Status**: Passed on 2026-07-10 after explicit product-owner confirmation.

Do not begin Phase I implementation until:

Product decisions:

1. New chats require a project; task binding is optional, and legacy unassigned chats remain bounded read-compatible records.
2. Task status remains explicit canonical board state while thread state is an aggregate badge/attention projection.
3. A busy thread rejects another normal turn with a recoverable state instead of silently queueing it.
4. Conversation and Kanban are the two primary agent-workspace views on desktop and mobile.

Already-established model constraints:

- One visible chat/session equals one resumable thread.
- One task may own several independent threads.

Mechanical readiness checks:

- Product-owner confirmation of all four decisions is recorded in `tasks.md`.
- `SPEC.md`, `ARCHITECTURE.md`, `plan.md`, `tasks.md`, and `acceptance-tests.md` use the same terminology/cardinality and all acceptance IDs are mapped.

### Gate B0 - Full Workspace Confirmation

**Status**: Awaiting product-owner confirmation.

Confirm `FULL-WORKSPACE-BACKEND.md`, explicit non-goals, owner-Postgres migration,
personal/org/shared export-delete model, canonical computer contract, isolated
preview authority, backend Graphite stack, and gate-specific shell handoffs.

### Gate B0.5 - Canonical Computer And Preview Acceptance

Proceed with current shell computer-selection layers only when:

- Clerk and native/sync principals consume one bounded computer schema and route.
- Selected slot is server-derived only from a principal that carries it.
- Desktop bearer rotation remains native/sync-authenticated and main-process-only;
  mobile persists validated same-origin routing only.
- Native Linux app HTTP/WebSocket streaming passes unchanged.
- One isolated PR/head-SHA preview environment owns platform plus disposable VPS,
  fails closed without preview credentials, and tears down completely.
- Desktop and physical mobile list/select the same non-primary computer.

### Gate 1 - Contract Acceptance

Proceed only when:

- Schemas cover all planned runtime primitives.
- Tests reject malformed payloads.
- At least gateway and one client can import types without circular dependencies.
- Sensitive-field audit passes.

### Gate 2 - Summary Acceptance

Proceed only when:

- Summary route works for authenticated owner.
- Summary is safe when providers/runtime are unavailable.
- Lists are capped.
- Desktop and mobile can render read-only dashboards from summary.

### Gate 3 - Thread Creation Acceptance

Proceed only when:

- Thread create is idempotent.
- Event stream supports replay.
- Fake provider test covers lifecycle.
- First real provider path is behind flag.
- Abort does not affect unrelated work.

### Gate 4 - Cross-Shell Continuity Acceptance

Proceed only when:

- Desktop and mobile can open the same thread.
- Terminal session created in one shell can attach in another.
- Approval resolved in one shell updates the other.
- Runtime switch closes stale streams.

### Gate 5 - Review/Preview Acceptance

Proceed only when:

- File read/write paths are conflict-safe.
- Diff snapshots are bounded.
- Preview origins are validated.
- Existing app embeds still pass regression checks.

### Gate 6 - Rollout Acceptance

Proceed only when:

- Desktop and mobile regression checklists pass.
- Error-path audit passes.
- Public docs are updated or explicitly deferred.
- Deployment path is documented for platform/app-shell/host-bundle/native mobile impacts.

### Gate 7 - Project Conversation Acceptance

Proceed to final rollout only when:

- Runtime hydration returns canonical projects and bounded task/thread projections.
- Same-thread follow-up resumes one provider conversation and passes idempotency/busy tests.
- A task with several threads is navigable from both shells.
- Conversation/Kanban mode switching preserves valid identity across desktop/mobile.
- Existing project board and task mutations remain canonical and regression tests pass.

## Risk Register

### Risk: Contract Drift

Clients may implement local shapes instead of shared schemas.

Mitigation:

- Contract package or single gateway-local contract source.
- Contract tests in every client adapter.
- PR review checks for duplicate schema definitions.

### Risk: Desktop Renderer Credential Exposure

New runtime client code may accidentally pass credentials to renderer.

Mitigation:

- Trusted core owns credential.
- Renderer receives safe projections only.
- IPC response schemas exclude tokens.
- Add tests scanning IPC response fixtures for forbidden keys.

### Risk: Mobile Resume Uses Stale Runtime IDs

AsyncStorage may point to deleted threads/sessions.

Mitigation:

- Parse then reconcile against runtime summary.
- Drop stale references.
- Fall back to recent work.

### Risk: Terminal Session Model Fork

Agent work may introduce separate terminal session logic.

Mitigation:

- Thread binding references canonical terminal session IDs/names.
- Reuse existing session list/attach/delete behavior.
- Add cross-shell attach tests.

### Risk: Unbounded Streams And Memory

Agent threads and terminal output can grow indefinitely.

Mitigation:

- Event cursors.
- Transcript windows.
- Ring buffers.
- Subscriber caps.
- Stale connection cleanup.
- LRU workspace panels.

### Risk: Raw Errors Leak To UI

Provider setup and command execution may return sensitive details.

Mitigation:

- Central safe error mapper.
- Client allowlist/cap error strings.
- Error-path tests.
- Detailed logs only in redacted diagnostics.

### Risk: Existing Mobile/Desktop Regression

New agent workspace could break current terminal/app/canvas/settings flows.

Mitigation:

- Feature flags.
- Read-only rollout first.
- Regression checklist per phase.
- Avoid replacing existing screens until supersets are verified.

### Risk: Native Mobile Terminal Complexity

Native terminal may destabilize SDK 57 builds.

Mitigation:

- Separate spike.
- Capability flag.
- WebView fallback.
- Device validation.
- No removal of existing terminal until native is proven.

### Risk: Singular Task Session Assumptions

Existing task UI has a singular `linkedSessionId` and may treat a live session as the only agent for a task.

Mitigation:

- Keep canonical terminal linkage for compatibility, but add a separate one-to-many task/thread projection.
- Never infer coding-thread cardinality from `linkedSessionId`.
- Add tests with at least two threads on one task in contracts, gateway, desktop, mobile, and E2E.

### Risk: Follow-Up Creates Replacement Threads

Current checkpoint follow-up behavior can seed a new thread with a structured reference instead of resuming the selected conversation.

Mitigation:

- Add a dedicated idempotent turn route and provider resume contract.
- Make selected-thread composer call the turn route.
- Keep "new chat from this context" as a separate explicit command.
- Assert thread ID and provider conversation identity remain stable across sequential turns.

### Risk: Task Status Drift From Agent Status

Several threads on one task may be running, blocked, failed, and complete simultaneously.

Mitigation:

- Keep task status canonical and explicitly mutated.
- Compute bounded thread aggregates for display only.
- Never auto-move cards from a renderer effect or thread reducer.

## Implementation Patterns

### Pattern: Additive Route

1. Add schema.
2. Add focused tests.
3. Add service function.
4. Add route with auth/body limit/validation.
5. Add safe error mapper.
6. Add client adapter.
7. Add UI behind flag.

### Pattern: Event Reducer

1. Define event union.
2. Write reducer tests for every event.
3. Add duplicate-event handling.
4. Add unknown-event handling.
5. Add cap/truncation behavior.
6. Wire stream.
7. Render projection, not raw events.

### Pattern: Cross-Shell Feature

1. Gateway contract.
2. Browser shell or CLI compatibility check.
3. Desktop adapter.
4. Mobile adapter.
5. Shared test fixtures.
6. Cross-shell E2E.

### Pattern: Provider Setup

1. Provider registry returns setup required.
2. UI shows setup action.
3. Setup opens foreground terminal command/session.
4. User completes auth/install.
5. Provider health refreshes.
6. Provider becomes selectable.

### Pattern: Runtime Switch

1. User selects runtime.
2. Client cancels old in-flight requests.
3. Client closes old streams.
4. Trusted core clears embedded sessions if needed.
5. Client fetches new summary.
6. Client drops stale local references.
7. Client renders new runtime safely.

## Documentation Plan

Internal:

- `docs/dev/coding-agent-shells.md`
- Include contracts, route map, event reducer guide, provider adapter guide, terminal binding guide, approval lifecycle, and client state rules.

Public:

- Add/update docs under `www/content/docs/`.
- Explain desktop/mobile coding-agent workflows.
- Explain remote Matrix computer model.
- Explain provider setup.
- Explain session continuity.

Support:

- Add troubleshooting for provider setup, runtime offline, terminal attach failure, mobile native terminal if applicable.
- Keep public repo safe: no customer identifiers, secrets, private hostnames, or incident-only commands.

## Recommended First Three PRs

The original first three PRs below are historical and have landed. The Full Workspace implementation stack begins only after Gate B0 confirmation.

### PR 1 - Contracts

Deliver:

- Shared schemas for IDs, safe errors, runtime summary, providers, threads, events, approvals, terminal summaries.
- Tests.
- No UI.

Why first:

- Gives every later agent a stable vocabulary.

### PR 2 - Gateway Summary

Deliver:

- Authenticated runtime summary route.
- Provider summary adapter.
- Terminal summary adapter.
- Caps and safe errors.
- Tests.

Why second:

- Enables desktop/mobile read-only work without provider execution risk.

### PR 3 - Read-Only Clients

Deliver:

- Desktop runtime summary IPC and dashboard behind flag.
- Mobile runtime summary client and recent work screen behind flag.
- Existing behavior preserved.

Why third:

- Verifies cross-client shape early and gives product feedback before mutating runtime.

## Recommended Next PR Stack

1. **`contracts(agent-shells): add project task and turn schemas`**
   - Project/task aggregates, workspace projection, same-thread turn request/response.
   - Schema tests only.

2. **`feat(gateway): hydrate project agent workspaces`**
   - Real project adapter, task/thread grouping, relation validation, caps, safe errors.
   - Read-only gateway tests.

3. **`feat(agents): add resumable conversation turns`**
   - Idempotent turn route, atomic active-turn ownership, provider resume, fake-provider tests.

4. **`feat(desktop): add project conversation navigator`**
   - Project/task/thread left navigator and same-thread Conversation view behind capability.

5. **`feat(desktop): integrate agent Kanban mode`**
   - Canonical task board projection with multi-thread badges and view identity continuity.

6. **`feat(mobile): add project conversation routes`**
   - Project/task/thread hierarchy and same-thread follow-up on SDK 57.

7. **`feat(mobile): add agent Kanban mode`**
   - Phone/tablet board and cross-view selection continuity.

## Full Workspace Backend Roadmap

The complete backend expansion follows
[FULL-WORKSPACE-BACKEND.md](./FULL-WORKSPACE-BACKEND.md) and does not stack on a
desktop or mobile branch.

### Phase N - Durable Workspace Store

- Add Zod V2 contracts and Kysely schema/repository tests first.
- Add owner-Postgres tables for conversations, turns, transcript, queue, runs,
  bindings, attachments, attention, review comments, participants, and
  idempotency.
- Import the legacy owner file idempotently and preserve a rollback export.
- Cut writes over once; avoid indefinite dual-write state.

### Phase M0 - Canonical Computer And Preview Foundation

- Reconcile the independently proposed desktop/mobile computer schemas into one
  bounded `GET /api/auth/computers` projection.
- Keep selected slot server-derived only for principals that carry one; desktop
  bearer rotation stays behind verified native/sync auth and trusted IPC, while
  mobile persists only validated same-origin routing.
- Preserve current native Linux app HTTP/WebSocket streaming behavior.
- Replace split preview authority with one isolated PR/head-SHA environment,
  exact bundle, fail-closed credentials, TTL/reaper, and teardown.
- Prove desktop and physical mobile can list/select the same disposable computer
  before either current shell stack merges its computer-selection layer.

### Phase O - Complete Transcript And Session Lifecycle

- Add stable latest/backward/forward transcript pages and explicit replay gaps.
- Add rename/archive/unarchive/fork and complete replay after restart.
- Add safe provider-session discovery/import.
- Run fake-provider and first real-provider continuity smoke.

Desktop/mobile may begin final transcript and session-list work only after this
phase publishes the versioned shell handoff.

### Phase P - Busy Work And Execution Graph

- Add explicit pending-message queue with edit/reorder/remove and atomic claims.
- Add steering and active-turn interruption behind provider capabilities.
- Add bounded parent/child execution graph and normalized run events.
- Add durable attention inbox and acknowledgement.
- Add the first-release provider conformance harness and normalized adapters for
  Claude Code, Codex, Pi, OpenCode, custom ACP-compatible backends, Kiro,
  GitHub Copilot CLI, Qwen Code, Kimi CLI, Kilo Code, and Auggie.
- Keep Gemini CLI outside this release and publish granular capabilities from
  real-process evidence rather than binary detection.

### Phase Q - Complete Project Tooling

- Add many-terminal bindings over canonical Matrix sessions.
- Add repository status and bounded branch/stash/pull/push/worktree operations.
- Add durable structured review comments and bounded attachments.
- Keep file/review/preview/source-control roots owner-validated.

### Phase R - Handoff And Collaboration

- Add persisted runtime compatibility and handoff saga.
- Add owner/editor/viewer participants aligned with owner/org/shared access.
- Add audit events for grants, decisions, handoffs, terminal/file/repository
  mutations, and revocations.

### Phase S - Shared Preview Acceptance

- Deploy the exact backend top to a disposable preview computer.
- Point desktop and mobile clients at the same preview runtime.
- Use one project fixture with two task conversations, imported history, queued
  work, child runs, two terminals, repository changes, review comments,
  attachment, preview, approval, attention, reconnect, restart, and handoff.
- Keep the current shell preview computer available as a visual baseline only;
  do not make backend persistence or contracts depend on that shell PR.

## Full Workspace Graphite Stack

1. Spec confirmation.
2. Canonical computer inventory/native identity.
3. Isolated end-to-end preview authority and native-stream preservation.
4. Workspace V2 contracts.
5. Postgres schema/repository/import/export/delete.
6. Transcript and lifecycle.
7. Queue and steering.
8. Execution graph, provider profiles/assets, and attention.
9. First-class provider adapters and conformance harness.
10. Compatibility provider adapters.
11. Terminal/repository/review/attachment bindings.
12. Handoff and collaboration.
13. Memory, automation, voice-action, policy, retention, and recovery integration.
14. Non-visual desktop/mobile client plumbing.
15. Preview smoke, security, performance, docs, and rollback evidence.

Each layer opens ready for review, targets fewer than 1,000 additions and 20
files where practical, and receives current-head CI plus Greptile 5/5 before
merge. Lower layers may merge while higher layers continue only when their
published contracts are stable and their rollback boundary is independently
valid.

## Shell Coordination During Backend Work

- Desktop freezes backend field/route invention at its current preview
  checkpoint and may continue Matrix-native visual work against deterministic
  fixtures.
- Mobile freezes backend field/route invention at its current stack top and may
  continue responsive navigation/composer work against the same fixtures.
- At Gate B0.5, the existing desktop and mobile stacks reconcile only their
  overlapping computer-contract layers, preserving each stack's current parent
  lineage. Once that backend layer merges, restack each stack bottom-up rather
  than rebasing an isolated top directly onto `main`.
- Current computer/navigation layers may finish after B0.5; complete transcript,
  lifecycle, queue, run, terminal/repository, and attention UI waits for the
  corresponding B2/B3/B4 handoff.
- At Backend Gate B2, both agents consume `backend-v2-shell-handoff.md` and
  target the backend preview computer. Non-visual trusted-core/mobile client
  plumbing is delivered by the backend workstream before final screen work.
- Each shell PR records the exact backend SHA, preview bundle, capabilities, and
  focused/manual acceptance exercised.

## Stop Conditions

Stop and ask for design review if:

- A task requires changing canonical auth flow.
- A task requires storing provider credentials client-side.
- A task requires new persistence technology.
- A task requires removing existing mobile terminal fallback.
- A task requires changing production VPS deployment model.
- A task requires bypassing route/WS validation.
- A task cannot be tested without relying on manual happy path only.
