# Acceptance Tests: Project Conversations And Kanban

**Status**: Phase 18-20 backend evidence, Phase 21 desktop navigator/conversation/Kanban/computer/inspector evidence, and Phase 22.1-22.3 mobile automated evidence added; device, security, and cross-shell evidence remains planned
**Updated**: 2026-07-10

This matrix is the executable acceptance contract for the clarified coding-agent shell model. A task checkbox in `tasks.md` is complete only when its named test IDs have current evidence on the exact implementation head. Existing checkpoint tests remain required regressions but do not prove these new cases.

## Fixture Model

All layers use the same representative fixture:

- Runtime `rt_primary` owned by one authenticated test principal.
- Projects `matrix-os` and `website`.
- Task `task_auth` in `matrix-os` with two threads: `thread_plan` and `thread_fix`.
- One project-level thread `thread_audit` in `matrix-os`.
- One task-bound thread `thread_docs` in `website`.
- `thread_fix` receives two sequential user turns using one stable provider conversation identity.
- Canonical task columns: `todo`, `running`, `waiting`, `blocked`, `complete`; `archived` is hidden from the normal board.

Tests must also cover another owner to prove isolation.

## Requirement Coverage

| Requirement group | Acceptance evidence |
| --- | --- |
| `FR-010` through `FR-016`, `FR-110` through `FR-113`, `SC-003`, `SC-023`, `SC-026` | `CT-104`; `GW-103`, `GW-105`, `GW-112`, `GW-118`; `E2E-104` |
| `FR-006`, `FR-007`, `FR-028`, `SC-011`, `SC-014` | `CT-001` through `CT-004`; `GW-001` through `GW-011`; `E2E-002` |
| `FR-020`, `FR-026`, `FR-027`, `FR-029`, `SC-003`, `SC-013` | `CT-005` through `CT-007`; `GW-012` through `GW-018`; `E2E-001`, `E2E-003` |
| `FR-062`, `FR-066`, `FR-067`, `SC-011`, `SC-012` | `DT-001` through `DT-012`; `E2E-002`, `E2E-004`, `E2E-005` |
| `FR-070`, `FR-075`, `FR-076`, `FR-077`, `SC-002`, `SC-011`, `SC-012` | `MB-001` through `MB-010`; `E2E-002` through `E2E-004` |
| `FR-002`, `FR-004`, `FR-061`, `FR-072`, `FR-075`, `FR-080` through `FR-083`, `SC-009`, `SC-010` | `SEC-001` through `SEC-006`; all layer-specific failure tests |
| Existing terminal/review/preview/approval/notification and preservation requirements | `E2E-006` plus the existing regression suites inventoried in `current-state.md` |

Every clarified functional requirement and buildable success criterion has at least one named test. Existing requirements not changed by this clarification retain their previously inventoried focused/regression tests.

## Contract Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| CT-001 | Project summary is bounded and carries safe task/thread/attention counts. | Zod 4 parse/reject tests in `tests/contracts/coding-agent-project-conversations.test.ts`. |
| CT-002 | Task agent summary uses canonical status/priority values and bounded aggregate counts. | Valid fixture plus negative status/count/title/ID cases. |
| CT-003 | Project workspace has independent bounded task, project-thread, and task-thread lists with truncation/cursors. | Oversized nested/list fixtures reject; boundary-size fixtures pass. |
| CT-004 | Thread list filters validate required project and optional task IDs independently. | Valid project-only/task filter plus malformed/cross-field rejection fixtures. |
| CT-005 | Turn request bounds message, attachments, and idempotency key. | Empty/oversized/unsafe ID/too-many attachment cases reject. |
| CT-006 | Turn response/error/lifecycle contracts never include provider credentials or resume identity. | Valid `thread_busy`/`thread_not_found`/`turn_unavailable` safe errors plus forbidden/unknown-field rejection. |
| CT-007 | Additive capability IDs parse for project workspaces, same-thread turns, and Conversation/Kanban views. | Runtime summary schema compatibility tests for enabled/disabled flags. |

## Gateway Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| GW-001 | Runtime summary returns canonical projects when projects exist. | Canonical owner-service wiring and non-empty fixtures in `tests/gateway/coding-agents-project-summary.test.ts`. |
| GW-002 | Project summaries are stable sorted and capped. | More-than-limit fixture returns deterministic items and `hasMore` in `tests/gateway/coding-agents-project-summary.test.ts`. |
| GW-003 | Project adapter failure produces safe degraded state without raw error data. | Failure, timeout, stalled-dependency, response, and log assertions in `tests/gateway/coding-agents-project-summary.test.ts`. |
| GW-004 | Project workspace route authenticates before success. | Route and capability tests in `tests/gateway/coding-agents-project-workspace.test.ts` prove auth-before-read and enablement only with an available read model. |
| GW-005 | Project workspace validates path/query/cursors/limits. | Malformed, unknown, and oversized queries are rejected before service use in `tests/gateway/coding-agents-project-workspace.test.ts`. |
| GW-006 | One task projects two independent threads. | Focused and owner-service fixtures return `thread_plan` and `thread_fix` under `task_auth` with count 2 in `tests/gateway/coding-agents-project-workspace.test.ts`. |
| GW-007 | Project-level threads remain separate from task-bound threads. | `thread_audit` appears only in the project-level list in `tests/gateway/coding-agents-project-workspace.test.ts`. |
| GW-008 | Workspace lists and aggregates are capped without nested transcript/event payloads. | A 104-thread fixture proves independent truncation and exact bounded aggregates; an owner-service fixture quarantines a cross-project task relation without mutation in `tests/gateway/coding-agents-project-workspace.test.ts`. |
| GW-009 | New shell-created thread requires an owned project. | Missing, stale, and unauthorized project fixtures fail safely before provider launch or persistence; an owned project succeeds in `tests/gateway/coding-agents-thread-relations.test.ts`. |
| GW-010 | Task-bound thread must use the task's project. | A `website` task submitted with the `matrix-os` project is rejected before provider launch or persistence in `tests/gateway/coding-agents-thread-relations.test.ts`. |
| GW-011 | Duplicate create is idempotent with project/task relation unchanged. | A retry with the same `clientRequestId` and a changed stale relation returns the original thread and invokes the provider once in `tests/gateway/coding-agents-thread-relations.test.ts`. |
| GW-012 | Turn route has auth, body limit, Zod params/body validation, ownership, and safe errors. | Auth, oversized body, malformed thread/body, cross-owner, stale-relation, and generic error assertions in `tests/gateway/coding-agents-turns.test.ts`. |
| GW-013 | Turn acceptance atomically appends one user turn and claims active ownership. | Store/route test replays the persisted `turn.accepted` event after the 202 response in `tests/gateway/coding-agents-turns.test.ts`. |
| GW-014 | Duplicate turn request returns the original accepted turn. | Same `(owner, thread, clientRequestId)` returns one turn both in-process and after store reload in `tests/gateway/coding-agents-turns.test.ts`. |
| GW-015 | Concurrent normal turn returns safe `thread_busy`. | Parallel route requests produce one 202 and one generic 409 with no local queue in `tests/gateway/coding-agents-turns.test.ts`. |
| GW-016 | Sequential turns resume one provider conversation. | Fake adapter receives two distinct persisted turns for one thread and one unchanged server-only conversation identity in `tests/gateway/coding-agents-turn-dispatch.test.ts`; workspace-provider coverage proves input delivery settles the turn while the canonical running session keeps the thread active. |
| GW-017 | Completion/failure/abort releases active-turn ownership. | Sequential completion, timeout failure, explicit abort, and persisted startup reconciliation each allow a later valid turn in `tests/gateway/coding-agents-turn-dispatch.test.ts`. |
| GW-018 | Provider timeout/abort maps to bounded safe thread state. | Timeout, shutdown abort, registry cap, saturated idempotent retry, terminal request-body cleanup, safe persisted failure, and raw resume-identity exclusion assertions in `tests/gateway/coding-agents-turn-dispatch.test.ts`. |
| GW-019 | Legacy adoption and project/task/thread projection updates are explicit, idempotent, and post-persistence. | Contract, auth, body-limit, owner/relation, exact-retry, publish-after-write, projection-failure isolation, and ordinary turn lifecycle assertions in `tests/gateway/coding-agents-thread-adoption.test.ts`, `tests/gateway/coding-agents-thread-projection.test.ts`, and `tests/gateway/coding-agents-turn-dispatch.test.ts`. |

## Desktop Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| DT-001 | Navigator renders both projects from trusted IPC projection. | `tests/desktop/coding-agent-project-navigator.test.tsx`, the integrated `AgentWorkspace` fixture, and trusted-core client/IPC tests. |
| DT-002 | One task expands to two independently selectable thread rows. | Accessible independent-row assertions in `tests/desktop/coding-agent-project-navigator.test.tsx` plus grouping-model coverage. |
| DT-003 | Project-level thread is not rendered as task-bound. | `tests/desktop/coding-agent-project-workspace.test.ts` and the project-chat/task-group component assertions. |
| DT-004 | Stale persisted project/task/thread references reconcile to a valid fallback. | `tests/desktop/coding-agent-project-workspace-store.test.ts` covers initial hydration and runtime switching; model tests cover stale task/thread fallback. |
| DT-005 | Selected-thread composer invokes turn IPC, not create-thread IPC. | Exact trusted-client, IPC handler, store, and conversation-component invocation tests with thread ID and bounded idempotency key. |
| DT-006 | Busy/offline/duplicate turn outcomes keep draft/selection safely recoverable. | Store/component tests prove allowlisted copy, identical retry-key reuse, edited-message key rotation, retained draft, and stale-selection protection. |
| DT-007 | Explicit new-chat action remains separate and can target project plus optional task. | Navigator/composer routing tests plus gateway workspace-provider coverage for server-owned worktree provisioning when the optional worktree reference is absent. |
| DT-008 | Conversation/Kanban segmented control preserves selected project. | `tests/desktop/coding-agent-kanban.test.tsx`, `tests/desktop/coding-agent-project-workspace-store.test.ts`, and the integrated workspace mode-switch assertion preserve project/task/thread identity. |
| DT-009 | Kanban uses canonical task columns/order and task mutation path. | The integrated `AgentWorkspace` test joins the project projection to the existing board store and asserts the canonical `/api/projects/:slug/tasks/:taskId` PATCH; `tests/desktop/board-store.test.ts` remains the mutation source-of-truth coverage. |
| DT-010 | Task card shows bounded count/active/attention aggregates and opens either attached thread. | `tests/desktop/coding-agent-kanban.test.tsx` renders both task chats and all three bounded aggregate types. |
| DT-011 | Thread status updates badges but never dispatch task movement. | `tests/desktop/coding-agent-kanban.test.tsx` rerenders mixed thread state and proves no task movement callback occurs. |
| DT-012 | Contextual files/diff/git, terminal, preview, and activity tools render as one accessible responsive inspector without changing their source of truth. | `tests/desktop/coding-agent-context-inspector.test.tsx` proves tab selection/counts/keyboard behavior, draft preservation, and external Changes focus; `tests/desktop/coding-agent-workspace.test.tsx` proves the existing trusted IPC actions after explicit surface selection. |

## Mobile Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| MB-001 | Agents entry renders project-first recent/attention state. | SDK 57 Jest route test. |
| MB-002 | Selected project renders project-level threads and task groups. | Fixture route/component test. |
| MB-003 | One task exposes two independent thread routes. | Navigation assertions for both thread IDs. |
| MB-004 | AsyncStorage contains only bounded selected project/task/thread/view references and drops stale IDs. | Persistence parser/reconciliation tests. |
| MB-005 | Thread composer posts a turn to the selected thread. | Gateway-client/component invocation test; create-thread is not called. |
| MB-006 | Busy/offline/app-resume behavior preserves recoverable draft and rehydrates snapshot. | Hook/route lifecycle tests. |
| MB-007 | Canonical terminal handoff remains a bounded session reference. | Existing terminal handoff regression plus project/thread fixture. |
| MB-008 | Conversation/Kanban control preserves selected project/task/thread. | Phone route/state test. |
| MB-009 | Kanban renders canonical columns and multi-thread card aggregates. | Phone and tablet-width component tests. |
| MB-010 | Opening either thread from a task card returns to the same conversation identity. | Router parameter validation/navigation test. |
| MB-011 | A Cloud-authenticated phone can switch to a server-projected main/preview computer without signing out or caching the inventory. | Platform route, secure storage, and native chooser tests. |

### Phase 22.1 Evidence

- `MB-001`: `apps/mobile/__tests__/agent-project-entry-route.test.tsx` proves the Agents entry opens a gateway-projected project and starts creation with that exact project ID; the existing attention/recent-work assertions remain in `apps/mobile/__tests__/agents-screen.test.tsx`.
- `MB-002`: `apps/mobile/__tests__/agent-project-workspace-screen.test.tsx` hydrates the shared `ProjectAgentWorkspaceSchema` projection and renders the project chat plus its task group.
- `MB-003`: the same component test opens both `thread_plan` and `thread_fix` independently with the exact `projectId`/`taskId`/`threadId`; `apps/mobile/__tests__/agent-project-route.test.tsx` verifies those IDs cross the Expo Router boundary unchanged.
- `MB-004` and `SEC-004`: `apps/mobile/__tests__/agent-workspace-state.test.ts` and the project-workspace lifecycle test cover allowlisted serialization, malformed storage, runtime/project reconciliation, stale child IDs, foreground refresh, and reconnect refresh. Device smoke remains part of the Phase 22 gate and is not proven by these Jest tests.

### Phase 22.2 Evidence

- `MB-005`: `apps/mobile/__tests__/gateway-client.test.ts` validates the authenticated, schema-checked `POST /api/coding-agents/threads/:threadId/turns` client. `apps/mobile/__tests__/agent-thread-screen.test.tsx` proves the Conversation composer posts to the currently selected thread, refreshes that bounded snapshot, clears the accepted draft, and never calls create-thread.
- `MB-006`: the thread-route tests cover busy retry with the same idempotency key, duplicate-submit suppression, offline draft retention, fail-closed capability checks, reconnect rehydration, and foreground snapshot refresh. Drafts stay transient component state and are not added to AsyncStorage.
- `MB-007`: the existing thread-route terminal regression still persists and opens only the canonical bounded `terminalSessionId`; the project-route fixtures keep the exact selected project/task/thread identity. Device keyboard, safe-area, background, and terminal handoff smoke remain part of the Phase 22 gate and are not proven by Jest.

### Phase 22.3 Evidence

- `MB-008`: `apps/mobile/__tests__/agent-project-workspace-screen.test.tsx`, `apps/mobile/__tests__/agent-workspace-state.test.ts`, and `apps/mobile/__tests__/agent-project-route.test.tsx` prove the capability-gated Conversation/Kanban control changes only the view reference, preserves the selected project/task/thread IDs, and replaces the Expo route with the matching project URL.
- `MB-009`: the project-workspace screen test renders phone and tablet board layouts from `ProjectAgentWorkspaceSchema`, asserts canonical `todo`, `running`, `waiting`, `blocked`, and `complete` columns, keeps `archived` hidden, and shows the gateway-projected thread/active/attention aggregates. A mixed completed/running thread fixture remains in the canonical task column instead of inferring a task move.
- `MB-010`: the Kanban component test opens both `thread_plan` and `thread_fix` with their exact `projectId`/`taskId`/`threadId`, while `apps/mobile/__tests__/agent-project-board-route.test.tsx` proves the dedicated board route uses the shared project workspace in Kanban mode. SDK 57 device navigation remains part of the Phase 22 gate and is not proven by Jest.

### Phase 22.4 Evidence

- `MB-011`: `tests/platform/proxy-routing.test.ts` proves the Clerk-authenticated computer route returns only the current owner's bounded same-origin projection and rejects anonymous discovery. `apps/mobile/__tests__/mobile-computers.test.ts`, `storage.test.ts`, `computer-picker-screen.test.tsx`, and `settings-screen.test.tsx` prove response validation, credential-free selection persistence, Cloud sign-in recovery, and same-session gateway switching. Remote preview selection on a physical device remains part of the Phase 22 gate until the preview bundle is deployed.

## Security Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| SEC-001 | Every new mutation applies `bodyLimit` before parsing and validates route/body with Zod 4. | Turn route oversized/malformed tests in `tests/gateway/coding-agents-turns.test.ts`, route-focused mutation tests, and pattern scan. |
| SEC-002 | Project/task/thread/turn authorization is owner-scoped and rejects cross-owner references. | Project workspace, thread relation, and turn principal matrices in their focused gateway tests. |
| SEC-003 | Desktop renderer receives no bearer/provider credentials or provider resume IDs. | Strict project-workspace IPC request/response tests, trusted-core client tests, local resume-state schema tests, and forbidden-field assertions in the focused desktop suites. |
| SEC-004 | Mobile persistence excludes transcripts, events, terminal output, file/diff data, approvals, tokens, and provider state. | AsyncStorage serialization tests. |
| SEC-005 | Every external provider call has timeout/AbortSignal and safe error mapping. | Adapter timeout/failure tests. |
| SEC-006 | All collections, subscriber registries, turn/idempotency caches, and nested API lists have caps plus cleanup/drain behavior. | Unit tests and review checklist evidence. |

## Cross-Shell And E2E Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| E2E-001 | One thread accepts two sequential turns with one provider conversation. | Fake-provider gateway integration in `tests/gateway/coding-agents-turn-dispatch.test.ts` plus deterministic workspace provider/store integration in `tests/gateway/coding-agents-workspace-provider.test.ts`; real-process smoke remains part of Gate 3. |
| E2E-002 | Desktop creates two chats for one task; mobile sees both after hydration. | Stubbed automated E2E plus real-runtime checkpoint. |
| E2E-003 | Mobile sends a follow-up; desktop receives events on the same thread. | Cross-shell real-runtime smoke with exact thread ID. |
| E2E-004 | Both shells switch Conversation/Kanban and reopen the same task/thread. | Desktop automated smoke, mobile device smoke, and recorded IDs. |
| E2E-005 | Explicit task move propagates while mixed thread states do not auto-move it. | Gateway workspace event plus both-shell projection smoke. |
| E2E-006 | Terminal, approval, review, preview, notification, offline/reconnect, and runtime-switch regressions pass with the project hierarchy enabled. | Existing suites plus updated desktop operator and SDK 57 device checklists. The Phase 21.1 desktop integration/store tests cover external thread focus and runtime switching; the remaining cross-shell evidence stays open. |

## Full Workspace V2 Contract And Persistence Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| PL-101 | Clerk and native/sync principals receive the same bounded canonical computer list; unauthenticated and cross-owner requests fail. | Shared contract plus platform route principal matrix. |
| PL-102 | `selected`, `runtimeSlot`, and the same-origin path (`/vm/{handle}` for primary, validated `runtime` query for non-primary) are server-derived; no machine IDs, IPs, credentials, private hosts, or operator data appear. | Valid/invalid projection and forbidden-key tests. |
| PL-103 | Desktop replacement bearer remains in trusted main while mobile switches same-origin gateway routing without bearer persistence. | Desktop auth/IPC and mobile storage/client tests. |
| PL-104 | Native identity fallback is emitted only from a server-verified native session and ignores client identity headers. | Auth/session route tests and shell fallback test. |
| PV-101 | Preview platform/VPS use isolated DB/JWT/edge/provisioning/Hetzner authority and fail closed without preview credentials. | Workflow/platform integration tests with production-secret fallback forbidden. |
| PV-102 | Preview lane label events and concurrency groups do not cancel each other; close/label removal reaps exact disposable resources. | Workflow contract tests and two-lane run evidence. |
| PV-103 | Existing native Linux app streaming/capability routes pass on the non-promoted combined candidate. | Exact-head candidate smoke before any traffic promotion. |
| CT-101 | Transcript pages validate monotonic sequences, direction, caps, gaps, structured entry kinds, and forbidden server-only fields. | `tests/contracts/coding-agent-workspace-v2.test.ts`. |
| CT-102 | Lifecycle, import, queue, steering, interrupt, run, binding, attachment, attention, handoff, and participant mutations have bounded discriminated schemas. | Valid/invalid parse matrix with unknown/oversized/unsafe payload rejection. |
| CT-103 | Capability/version negotiation remains additive for old shell/runtime combinations. | Old and V2 runtime summary fixtures parse with explicit disabled capability behavior. |
| CT-104 | Provider summaries use stable IDs plus protocol, support tier, readiness, and granular capabilities; the exact release roster parses while unknown built-ins, capability escalation, and oversized custom ACP profiles reject. | Zod 4 roster/tier/protocol/capability matrix with custom ACP handshake/version fixtures and Gemini built-in exclusion. |
| DB-101 | All V2 records are owner-scoped and multi-write operations are transactional. | Kysely repository tests with forced intermediate failures and cross-owner reads/writes. |
| DB-102 | Sequence allocation, pending claims, handoff transitions, and optimistic revisions are race-safe in the write statement. | Parallel transaction tests proving one winner and deterministic conflicts. |
| DB-103 | Legacy owner-file import is idempotent, preserves IDs/order/relations, and emits a rollback export. | Import twice, restart, malformed-record quarantine, and rollback tests. |
| DB-104 | Cutover serializes by scope, quiesces mutations, verifies the import checksum, and changes authority only when the `postgres_active` marker commits atomically. | Mutex/advisory-lock integration with concurrent mutation, checksum mismatch, and crashes immediately before/after commit; post-marker restart never reactivates file writes. |

## Full Workspace V2 Gateway Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| GW-101 | Latest/backward/forward transcript pages survive restart and report gaps without duplicate sequences. | 1,000-entry repository/route fixture and WebSocket reconnect integration. |
| GW-102 | Rename/archive/unarchive/fork/import operations enforce auth, body limits, validation, ownership, idempotency, and safe errors. | Route matrix including stale/cross-owner/import-token expiry. |
| GW-103 | Provider discovery/import returns safe metadata only and preserves one server-owned provider conversation identity. | Fake and first flagged real-provider tests plus forbidden-field scan. |
| GW-104 | Pending messages edit/reorder/remove by revision and dispatch exactly once in server order. | Concurrent claim, stale revision, restart, cap, and duplicate request tests. |
| GW-105 | Steering/interrupt targets one active turn and unsupported providers fail without queue fallback. | Adapter capability and route tests with timeout/abort. |
| GW-106 | Parent/child execution graph is acyclic and enforces depth, child, concurrency, and event-rate caps. | Repository/adapter tests with malicious and oversized graphs. |
| GW-107 | Durable attention dedupes and resolves approval/input/failure/completion/review/unread/handoff independently. | Two-subscriber replay/ack/resolve/expiry tests. |
| GW-108 | Several role-labelled terminal bindings reference canonical sessions and never persist output. | Bind/list/unbind/session-end/restart/cross-owner tests. |
| GW-109 | Repository, review-comment, and attachment operations remain inside owner worktrees and enforce revisions, quotas, cleanup, timeouts, and safe errors. | Traversal/symlink/SSRF/large-output/conflict/expiry matrices. |
| GW-110 | Runtime handoff preserves source on failed destination and commits one active destination on success. | Two-runtime saga tests with duplicate, timeout, restart, and compensation cases. |
| GW-111 | Owner/editor/viewer authorization and audit records cover every shared mutation. | Principal matrix over turns, approvals, terminals, files, repository, participants, and revocation. |
| GW-112 | Provider options, profiles, prompt/skill/MCP references, connected-service state, and quota summaries normalize safely without returning secret values. | Adapter/repository/route tests with immutable thread-start configuration snapshots. |
| GW-113 | Conversation memory search returns authorized bounded anchors and respects backfill/retention/scope without expanding embedded stores. | Owner-Postgres index/search authorization and cleanup tests. |
| GW-114 | Automations use durable leased/idempotent runs and invoke normal thread operations; voice uses the same actions and approval policy. | Scheduler/voice adapter tests with duplicate lease, retry, expiry, and unauthorized action cases. |
| GW-115 | Feature/retention policy, org/offboarding authorization, recovery checkpoints, and diagnostic snapshots remain server-enforced and redacted. | Policy disable, dry-run cleanup, restart/crash, offboarding, and forbidden-content tests. |
| GW-116 | Personal/org/shared export and deletion preserve scope separation, portability, tombstone exclusion, attachment/index cleanup, and audit/retry state. | Repository plus canonical export/delete integration tests. |
| GW-117 | Source-control mutations enforce their operation-specific preconditions and reconcile ambiguous remote outcomes without destructive fallback. | Per-action schema/service tests for dirty state, expected head, configured remote, conflict, timeout, idempotent retry, and audit. |
| GW-118 | Claude Code, Codex, Pi, OpenCode, custom ACP-compatible backends, Kiro, GitHub Copilot CLI, Qwen Code, Kimi CLI, Kilo Code, and Auggie pass the required provider conformance tier; Gemini CLI remains absent and unsupported capabilities are reported truthfully. | Table-driven fake adapters plus flagged real-process install/auth/create/stream/abort/restart/safe-error tests and per-capability negative cases. |

## Full Workspace V2 Shell And Preview Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| DT-101 | Desktop renders status-grouped conversations, complete paged transcript, pending queue, run graph, attention, contextual project tooling, provider controls, memory anchors, automation history, and policy/recovery states from trusted IPC only. | Focused renderer/store/IPC tests and desktop operator E2E against backend preview. |
| MB-101 | Mobile renders the same selected conversation, provider controls, memory/automation/policy states, and cockpit surfaces with safe resume, keyboard, orientation, foreground, and reconnect behavior. | SDK 57 Jest plus physical phone/tablet preview smoke. |
| SEC-101 | No V2 UI, log, notification, transcript envelope, or persisted client state exposes credentials, provider IDs intended to remain opaque, raw errors, private hosts, or unbounded owner data. | Forbidden-key/log/UI/persistence scans and manual unsafe-error audit. |
| SEC-102 | Repository files, commits, PR metadata, generated artifacts, tests, snapshots, and shipped UI contain no external evaluation source names/provenance/paths, copied code/test/UI text/assets, or imported dependency. | Current-head clean-room scan plus dependency/diff review recorded before every backend and shell handoff. |
| E2E-101 | Desktop and mobile target the same exact preview runtime and page one long transcript without duplicates. | Recorded backend SHA, bundle, runtime ID, thread ID, sequence bounds, and reconnect evidence. |
| E2E-102 | Provider controls, queued message, approval, child run, two terminals, attachment, file edit, review comment, commit/PR, preview, archive/fork, memory anchor, automation run, policy disable, recovery, and attention resolve propagate cross-shell. | One seeded owner project scenario on the disposable preview computer. |
| E2E-103 | Compatible runtime handoff succeeds; incompatible/failed handoff remains safely recoverable. | Two disposable runtime scenario with audit records and unchanged conversation ID. |
| E2E-104 | Every first-release provider starts one bounded preview conversation and completes or aborts safely without transcript/provider-state mixing; advanced actions appear only for providers with verified support. | Exact provider versions, runtime kinds, capability snapshots, thread IDs, and real-process smoke evidence recorded against the disposable preview computer. |

## Required Commands By Slice

Every implementation PR runs focused tests for its IDs plus applicable repository gates:

```bash
bun run check:patterns
bun run typecheck
pnpm --filter desktop run typecheck
pnpm --filter matrix-os-mobile run test
pnpm --filter matrix-os-mobile run lint
pnpm --filter matrix-os-mobile exec tsc --noEmit
```

Current Phase 21.1 evidence on the desktop navigator slice:

- `pnpm exec vitest run tests/desktop/coding-agent-project-workspace.test.ts tests/desktop/coding-agent-project-navigator.test.tsx tests/desktop/coding-agent-project-workspace-store.test.ts tests/desktop/coding-agent-workspace-section.test.tsx tests/desktop/coding-agent-runtime-client.test.ts tests/desktop/ipc-contract.test.ts tests/desktop/ipc-handlers.test.ts tests/desktop/local-store.test.ts tests/desktop/coding-agent-workspace.test.tsx`
- `pnpm exec vitest run tests/desktop --reporter=dot`
- `bun run typecheck`
- `bun run check:patterns`
- `bun run build:desktop`
- `pnpm exec vitest run tests/e2e/desktop/operator.e2e.test.ts`
- Built-app screenshots: `desktop/screenshots/04b-agents-kanban.png` and
  `desktop/screenshots/04c-agents-kanban-narrow.png`

These checks prove `DT-001` through `DT-004` and the desktop portion of
`SEC-003`. The integrated desktop tests additionally preserve external thread
focus and explicit projection refresh behavior from `E2E-006`; they do not
by themselves prove the later Conversation, Kanban, or cross-shell acceptance
cases.

Current Phase 21.2 evidence on the desktop Conversation slice:

- `pnpm exec vitest run tests/desktop/ipc-contract.test.ts tests/desktop/ipc-handlers.test.ts tests/desktop/coding-agent-runtime-client.test.ts tests/desktop/coding-agent-workspace.test.tsx tests/desktop/coding-agent-project-workspace-shell.test.tsx tests/desktop/coding-agent-project-workspace-store.test.ts tests/desktop/coding-agent-project-workspace.test.ts tests/gateway/coding-agents-provider-adapter.test.ts tests/gateway/coding-agents-threads.test.ts tests/gateway/coding-agents-turns.test.ts tests/gateway/coding-agents-workspace-provider.test.ts tests/gateway/workspace-session-orchestrator.test.ts tests/contracts/coding-agent-project-conversations.test.ts`
- `pnpm --filter desktop run typecheck`
- `bun run typecheck`
- `bun run check:patterns` (zero violations; repository baseline warnings only)
- `bun run build:desktop`
- `pnpm exec vitest run tests/e2e/desktop/operator.e2e.test.ts`

These checks prove `DT-005` through `DT-007`: selected conversations replay
gateway-owned user/assistant activity, the same-thread composer crosses strict
trusted IPC, busy/offline retry state stays recoverable without exposing raw
errors, and new-chat worktree creation remains a server-owned lifecycle. The
cross-shell cases remain open.

Current Phase 21.3 evidence on the desktop Kanban slice:

- `pnpm exec vitest run tests/desktop/coding-agent-kanban.test.tsx tests/desktop/coding-agent-project-workspace-store.test.ts tests/desktop/coding-agent-workspace.test.tsx tests/desktop/board-store.test.ts`
- `pnpm --filter desktop run typecheck`
- `bun run typecheck`
- `bun run check:patterns`
- `bun run build:desktop`
- `pnpm exec vitest run tests/e2e/desktop/operator.e2e.test.ts`

These checks prove `DT-008` through `DT-011`: the view switch preserves the
selected project/task/chat references, the board renders canonical columns and
bounded multi-chat aggregates, task moves reuse the existing canonical task
store and route, opening a card chat returns to the same conversation, and
thread state alone cannot mutate task status.

Current native computer-selection evidence:

- `pnpm exec vitest run tests/contracts/runtime-computers.test.ts tests/platform/proxy-routing.test.ts tests/desktop/auth-service.test.ts tests/desktop/credential-store.test.ts tests/desktop/ipc-contract.test.ts tests/desktop/ipc-handlers.test.ts tests/desktop/runtime-section.test.tsx tests/desktop/settings-view.test.tsx tests/desktop/embed-host.test.tsx`
- `pnpm --filter desktop run typecheck`
- `bun run typecheck`
- `bun run check:patterns`
- `bun run build:desktop`
- `pnpm exec vitest run tests/e2e/desktop/operator.e2e.test.ts`

These checks prove the desktop discovers only capped owner-scoped computer
summaries, rotates the selected runtime credential inside Electron main,
persists a bounded slot, rejects invalid or cross-owner selection, rehydrates
after `runtime:changed`, and contains raw platform or filesystem failures behind
generic desktop copy.

Current contextual conversation-inspector evidence:

- `pnpm exec vitest run tests/desktop/coding-agent-context-inspector.test.tsx tests/desktop/coding-agent-workspace.test.tsx`
- `pnpm exec vitest run tests/desktop --reporter=dot` (98 files, 908 tests)
- `pnpm --dir desktop typecheck`
- `bun run typecheck`
- `bun run check:patterns` (zero violations; repository baseline warnings only)
- `bun run build:desktop`
- `pnpm exec vitest run tests/e2e/desktop/operator.e2e.test.ts` (7 tests)
- Built-app screenshots: `desktop/screenshots/04d-agents-changes-inspector.png`
  and `desktop/screenshots/04e-agents-changes-inspector-narrow.png`

These checks prove `DT-012`: Changes, Terminal, Preview, and Activity expose one
bounded surface at a time, publish live counts from the current runtime summary,
support complete keyboard tab navigation, retain the new-chat controls, and
preserve the existing trusted file/review/source-control/terminal/preview paths.
External review actions reveal Changes, while hidden panes retain bounded
unsaved editor state.

Current Matrix computer Files evidence:

- `bunx vitest run tests/desktop/create-project-dialog.test.tsx tests/desktop/files-workspace.test.tsx tests/desktop/files-panel.test.tsx tests/desktop/markdown-preview.test.ts`
- `bunx vitest run tests/desktop` (99 files, 930 tests)
- `pnpm --filter desktop typecheck`
- `bun run typecheck`
- `bun run check:patterns:diff` (zero violations; existing stack warnings only)
- `bun run build:desktop`

These checks prove the selected computer remains the source of folder listings,
the project chooser submits a selected relative folder path, Files opens as a
stable desktop destination, bounded text/code and Markdown previews use the
gateway file routes, and image URLs contain runtime routing but no credentials.

Gateway/contract PRs additionally run the exact focused Vitest files named in their PR body. Desktop UI PRs run the operator E2E and screenshot checks. Mobile UI PRs run the SDK 57 dev-client device smoke before their rollout gate. `vp` commands may be reported unavailable, but they are not silently substituted for repository commands.

## Confirmation Boundary

This file defines planned evidence only. It must not be cited as proof that the clarified experience exists. The original project model began after Gate 0. The Full Workspace V2 backend begins only after the product owner confirms Gate B0 in `FULL-WORKSPACE-BACKEND.md` and `tasks.md`.
