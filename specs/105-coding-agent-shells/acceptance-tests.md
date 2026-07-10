# Acceptance Tests: Project Conversations And Kanban

**Status**: Specification checkpoint - no implementation evidence claimed
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
| `FR-006`, `FR-007`, `FR-028`, `SC-011`, `SC-014` | `CT-001` through `CT-004`; `GW-001` through `GW-011`; `E2E-002` |
| `FR-020`, `FR-026`, `FR-027`, `FR-029`, `SC-003`, `SC-013` | `CT-005` through `CT-007`; `GW-012` through `GW-018`; `E2E-001`, `E2E-003` |
| `FR-062`, `FR-066`, `FR-067`, `SC-011`, `SC-012` | `DT-001` through `DT-011`; `E2E-002`, `E2E-004`, `E2E-005` |
| `FR-070`, `FR-075`, `FR-076`, `FR-077`, `SC-002`, `SC-011`, `SC-012` | `MB-001` through `MB-010`; `E2E-002` through `E2E-004` |
| `FR-002`, `FR-004`, `FR-061`, `FR-072`, `FR-075`, `FR-080` through `FR-083`, `SC-009`, `SC-010` | `SEC-001` through `SEC-006`; all layer-specific failure tests |
| Existing terminal/review/preview/approval/notification and preservation requirements | `E2E-006` plus the existing regression suites inventoried in `current-state.md` |

Every clarified functional requirement and buildable success criterion has at least one named test. Existing requirements not changed by this clarification retain their previously inventoried focused/regression tests.

## Contract Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| CT-001 | Project summary is bounded and carries safe task/thread/attention counts. | Zod 4 parse/reject tests in `tests/contracts/coding-agents.test.ts`. |
| CT-002 | Task agent summary uses canonical status/priority values and bounded aggregate counts. | Valid fixture plus negative status/count/title/ID cases. |
| CT-003 | Project workspace has independent bounded task, project-thread, and task-thread lists with truncation/cursors. | Oversized nested/list fixtures reject; boundary-size fixtures pass. |
| CT-004 | Thread list filters validate required project and optional task IDs independently. | Valid project-only/task filter plus malformed/cross-field rejection fixtures. |
| CT-005 | Turn request bounds message, attachments, and idempotency key. | Empty/oversized/unsafe ID/too-many attachment cases reject. |
| CT-006 | Turn response and lifecycle events never include provider credentials or resume identity. | Valid safe fixtures and forbidden/unknown-field rejection. |
| CT-007 | Additive capability IDs parse for project workspaces, same-thread turns, and Conversation/Kanban views. | Runtime summary schema compatibility tests for enabled/disabled flags. |

## Gateway Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| GW-001 | Runtime summary returns canonical projects when projects exist. | `coding-agents-summary` test with non-empty project service fixture. |
| GW-002 | Project summaries are stable sorted and capped. | More-than-limit fixture returns deterministic items and `hasMore`. |
| GW-003 | Project adapter failure produces safe degraded state without raw error data. | Failure/timeout tests inspect response and logs. |
| GW-004 | Project workspace route authenticates before success. | Missing/invalid principal returns generic 401/403. |
| GW-005 | Project workspace validates path/query/cursors/limits. | Malformed and oversized queries rejected before service use. |
| GW-006 | One task projects two independent threads. | Fixture returns `thread_plan` and `thread_fix` under `task_auth` with count 2. |
| GW-007 | Project-level threads remain separate from task-bound threads. | `thread_audit` appears only in project-level list. |
| GW-008 | Workspace lists and aggregates are capped without nested transcript/event payloads. | Large fixture returns explicit truncation and schema-safe metadata only. |
| GW-009 | New shell-created thread requires an owned project. | Missing/stale/unauthorized project fails safely; valid project succeeds. |
| GW-010 | Task-bound thread must use the task's project. | `website` task with `matrix-os` project is rejected before insert/provider launch. |
| GW-011 | Duplicate create is idempotent with project/task relation unchanged. | Same `clientRequestId` returns original thread. |
| GW-012 | Turn route has auth, body limit, Zod params/body validation, ownership, and safe errors. | Focused route matrix covers every boundary. |
| GW-013 | Turn acceptance atomically appends one user turn and claims active ownership. | Transaction/store test observes no partial state. |
| GW-014 | Duplicate turn request returns the original accepted turn. | Same `(owner, thread, clientRequestId)` creates one turn/provider call. |
| GW-015 | Concurrent normal turn returns safe `thread_busy`. | Parallel store/route test proves one winner and no hidden queue. |
| GW-016 | Sequential turns resume one provider conversation. | Fake adapter records create once, resume once, stable internal conversation ID. |
| GW-017 | Completion/failure/abort releases active-turn ownership. | Each terminal outcome allows a later valid turn. |
| GW-018 | Provider timeout/abort maps to bounded safe thread state. | AbortSignal and raw-error redaction tests. |

## Desktop Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| DT-001 | Navigator renders both projects from trusted IPC projection. | Renderer test with fixture model. |
| DT-002 | One task expands to two independently selectable thread rows. | Accessible labels and selected thread assertions. |
| DT-003 | Project-level thread is not rendered as task-bound. | Grouping helper/component test. |
| DT-004 | Stale persisted project/task/thread references reconcile to a valid fallback. | Store hydration/runtime-switch tests. |
| DT-005 | Selected-thread composer invokes turn IPC, not create-thread IPC. | Exact invocation test with thread ID/idempotency key. |
| DT-006 | Busy/offline/duplicate turn outcomes keep draft/selection safely recoverable. | Store/component failure tests with generic copy. |
| DT-007 | Explicit new-chat action remains separate and can target project plus optional task. | Composer routing and contract tests. |
| DT-008 | Conversation/Kanban segmented control preserves selected project. | Component/store mode-switch test. |
| DT-009 | Kanban uses canonical task columns/order and task mutation path. | Board integration test; no duplicate agent-only task store. |
| DT-010 | Task card shows bounded count/active/attention aggregates and opens either attached thread. | Card/detail component tests. |
| DT-011 | Thread status updates badges but never dispatch task movement. | Reducer/effect regression with mixed thread states. |

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

## Security Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| SEC-001 | Every new mutation applies `bodyLimit` before parsing and validates route/body with Zod 4. | Route tests and pattern scan. |
| SEC-002 | Project/task/thread/turn authorization is owner-scoped and rejects cross-owner references. | Principal matrix tests. |
| SEC-003 | Desktop renderer receives no bearer/provider credentials or provider resume IDs. | IPC contract/handler fixtures and forbidden-key scan. |
| SEC-004 | Mobile persistence excludes transcripts, events, terminal output, file/diff data, approvals, tokens, and provider state. | AsyncStorage serialization tests. |
| SEC-005 | Every external provider call has timeout/AbortSignal and safe error mapping. | Adapter timeout/failure tests. |
| SEC-006 | All collections, subscriber registries, turn/idempotency caches, and nested API lists have caps plus cleanup/drain behavior. | Unit tests and review checklist evidence. |

## Cross-Shell And E2E Tests

| ID | Requirement | Expected Evidence |
| --- | --- | --- |
| E2E-001 | One thread accepts two sequential turns with one provider conversation. | Fake-provider integration test before real-provider smoke. |
| E2E-002 | Desktop creates two chats for one task; mobile sees both after hydration. | Stubbed automated E2E plus real-runtime checkpoint. |
| E2E-003 | Mobile sends a follow-up; desktop receives events on the same thread. | Cross-shell real-runtime smoke with exact thread ID. |
| E2E-004 | Both shells switch Conversation/Kanban and reopen the same task/thread. | Desktop automated smoke, mobile device smoke, and recorded IDs. |
| E2E-005 | Explicit task move propagates while mixed thread states do not auto-move it. | Gateway workspace event plus both-shell projection smoke. |
| E2E-006 | Terminal, approval, review, preview, notification, offline/reconnect, and runtime-switch regressions pass with the project hierarchy enabled. | Existing suites plus updated desktop operator and SDK 57 device checklists. |

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

Gateway/contract PRs additionally run the exact focused Vitest files named in their PR body. Desktop UI PRs run the operator E2E and screenshot checks. Mobile UI PRs run the SDK 57 dev-client device smoke before their rollout gate. `vp` commands may be reported unavailable, but they are not silently substituted for repository commands.

## Confirmation Boundary

This file defines planned evidence only. It must not be cited as proof that the clarified experience exists. Implementation begins only after the product owner confirms Gate 0 in `plan.md` and `tasks.md`.
