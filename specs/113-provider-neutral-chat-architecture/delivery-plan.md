# Desktop Chat and Project Workspace Delivery Plan

> **For agentic workers:** This is the cross-PR dependency plan, not a substitute
> for an executable issue plan. Before changing product code, write the focused
> issue plan and use `superpowers:test-driven-development` for every public seam.

**Goal:** Ship one canonical Chat system whose Global and Project entry points
share the same panel, messages, inspector, Gateway, persistence, and Provider
contracts.

**Architecture:** `Chat -> Turn -> Run attempt` is the durable execution tree.
A Run uses exactly one `Provider Driver -> Provider Instance -> Model Selection`.
The first accepted Turn locks the Chat to that Instance. Projects bind owner
resources without duplicating them, and an idle Chat can move between Projects
without changing identity.

**Tech stack:** TypeScript, Zod 4, Hono, Kysely/PostgreSQL, React 19, Zustand,
Vitest, Electron, and owner-VPS runtime validation.

**Canonical spec:** `specs/113-provider-neutral-chat-architecture/spec.md`

**Snapshot:** Reconciled against Linear and GitHub on 2026-08-24 and
`origin/main@6a86e2e1e`. Recheck status and exact heads before starting any
implementation PR.

## Locked product decisions

1. `Provider Driver` means Hermes, OpenClaw, Codex, Claude Code, OpenCode, or
   Pi. It is an execution runtime, not an LLM vendor.
2. `Provider Instance` means one concrete install/account/endpoint/configuration.
   The contract supports multiple Instances even if V1 exposes one per Driver.
3. Driver, Instance, model, and provider-specific options are separate. Effort,
   service tier, interaction mode, permission mode, skills, commands, and
   worktrees are capability-derived options rather than universal fields.
4. A draft Chat may change Driver/Instance. Its first accepted Turn atomically
   locks the exact Instance. A later Driver/Instance change requires Fork or New
   Chat. Compatible model/options may change inside the bound Instance.
5. Hermes/OpenClaw and coding Drivers appear in one selector, grouped by
   capability class; unavailable Drivers stay visible with truthful setup state.
6. Global Chat and Project Chat are routes into one `ChatSurface`,
   `ConversationTimeline`, `ChatComposer`, and `ChatInspector`.
7. `/` selects a typed skill/command invocation. `@` selects a typed resource
   reference; labels are never parsed back into paths or identities.
8. Chats are owner-owned and optionally Project-bound. Idle Chats may be added
   to, removed from, or moved between Projects without changing `chatId`.
9. Terminal Sessions belong to the computer/VPS terminal service and are
   workspace-scoped. Projects list them; Chats/Runs reference them.
   `terminalSessionId` is not a renderer `terminalTabId`. Zellij mapping is a
   later design.
10. `primaryWorkspaceRoot` is derived and validated for each Run from the
    Project/worktree reference. It is not stored as Chat identity and never
    comes from a renderer path.
11. Owner-local PostgreSQL/Kysely and Gateway are canonical. No new renderer
    persistence, alternate database, or second provider-specific Chat API.

## Current Matrix VPS Provider reality

“Provisioned” and “ready” are deliberately different. Models are supplied by
the configured account and runtime; they are not installed as Matrix assets.

| Driver | Matrix VPS provisioning on current `main` | Executable Chat path today | Final-framework treatment |
|---|---|---|---|
| Hermes | Default-selected agent tool pack; host install/runtime controls ship | Existing Gateway conversation rail | `system_agent` Driver and first canonical import adapter |
| OpenClaw | Host installer/runtime controls ship; not a default-ready runtime | No canonical Chat execution adapter | Visible `system_agent`; setup/unavailable until its adapter exists |
| Codex | Optional coding-agents pack; async install and auth required | Customer host registers the Codex workspace adapter | First coding Driver in canonical orchestration |
| Claude Code | Optional coding-agents pack; async install and auth required | Customer host registers the Claude workspace adapter | Same Driver/Instance contract as Codex |
| Pi | Optional coding-agents pack; async install and auth required | Direct structured adapter exists, but customer default provider list omits it | Add after the canonical contract; no special Chat type |
| OpenCode | Optional coding-agents pack; async install and auth required | No reliable canonical structured assistant/resume path | Visible but non-runnable until an adapter passes the same contract |

## Existing Linear and PR truth

These are inputs, not work to repeat.

| Linear | Current status | GitHub PR | Dependency role / required action |
|---|---|---|---|
| MAT-319 provider-neutral architecture | Done | [#1218](https://github.com/HamedMP/matrix-os/pull/1218) merged | Amend through this design PR; do not reopen the old implementation assumptions |
| MAT-299 Hermes conversation lifecycle | Done | [#1213](https://github.com/HamedMP/matrix-os/pull/1213) merged | Legacy Hermes source and compatibility seam for canonical import |
| MAT-318 persistent Project context | Done | [#1252](https://github.com/HamedMP/matrix-os/pull/1252) merged | Reuse stable Project ID and guarded context behavior; generalize to canonical Chat move |
| MAT-321 canonical Chat persistence/adapters | Todo | No PR | Replace as an umbrella; split into `MAT-472`, `MAT-473`, `MAT-477`, and `MAT-479` below |
| MAT-322 Chat inbox/composer/resources | Done | [#1231](https://github.com/HamedMP/matrix-os/pull/1231) merged | Reuse visual/components; remove its stale “blocked by MAT-321” relation during Linear cleanup |
| MAT-344 T3 Project Chat | In Progress | Umbrella | Keep as UI umbrella; children supply accepted components to final integration |
| MAT-345 Project Chat navigation/search | Done | [#1248](https://github.com/HamedMP/matrix-os/pull/1248) merged | Reuse list/search behavior against canonical summaries |
| MAT-346 contextual inspector | Done | [#1253](https://github.com/HamedMP/matrix-os/pull/1253) merged | Starting point for the side-panel refactor, not the final data contract |
| MAT-347 execution-root provenance | Todo | No PR | Critical backend dependency for canonical Run execution and exact turn changes |
| MAT-348 structured output/composer | Done | [#1251](https://github.com/HamedMP/matrix-os/pull/1251) merged | Reuse normalized activity UI and composer interactions |
| MAT-349 stream ordering | Done | [#1250](https://github.com/HamedMP/matrix-os/pull/1250) merged | Accepted ordering seam; prerequisite of MAT-458 |
| MAT-364 Desktop Chat beta-ready | In Progress | Umbrella | Final authenticated acceptance/hardening gate, not a feature bucket |
| MAT-453 Projects workflows | Done | [#1282](https://github.com/HamedMP/matrix-os/pull/1282) merged | Reuse Project identity, creation, and re-entry behavior |
| MAT-455 Chat/Files home lists | Done | [#1292](https://github.com/HamedMP/matrix-os/pull/1292) merged | Reuse list presentation and navigation patterns |
| MAT-458 typed activity timeline | In Progress | No attached PR | Keep Gateway normalization/persistence under Yuhan; split presentation polish into `MAT-474` |
| MAT-459 provider readiness | PR In Review in Linear | [#1294](https://github.com/HamedMP/matrix-os/pull/1294) merged | **Status drift:** reconcile Linear to merged truth before new dependency links |
| MAT-460 turn changes/file preview | In Progress, blocked | No PR | Split backend truth (`MAT-478`) from inspector UI (`MAT-481`); preserve MAT-347 and MAT-458 blockers |
| MAT-468 real Global Chat provider switching | Human Review | [#1299](https://github.com/HamedMP/matrix-os/pull/1299) open draft | Compatibility slice only; see disposition below |
| MAT-469 readiness refresh | Done | [#1300](https://github.com/HamedMP/matrix-os/pull/1300) merged | Reuse bounded refresh and draft-preservation behavior |
| Supporting global/project presentation | Merged | [#1293](https://github.com/HamedMP/matrix-os/pull/1293) merged | Reuse presentation composition; it is not canonical domain/persistence unification |

## Created Linear and proposed PR stack

The implementation issues below were created on 2026-08-24 in the Matrix OS
team, September Public Launch project, and current cycle. All are temporarily
assigned to Yuhan; teammates may select ownership later. Every PR retains one
owner and one coherent responsibility.

### MAT-470 — Final architecture amendment

**Temporary assignee:** Yuhan
**PR:** `docs(chat): finalize canonical Chat and workspace architecture`
**Depends on:** MAT-319/#1218 and the decisions in this document
**Blocks:** every new implementation issue

- Own only this spec and dependency plan.
- Record Driver/Instance/model semantics, first-Turn lock, Project/resource
  hierarchy, shared UI boundaries, migration, and PR graph.
- Gate: team architecture review. No runtime claim or product implementation.

### MAT-471 — Shared canonical Chat contracts and fixtures

**Temporary assignee:** Yuhan
**PR:** `feat(contracts): add canonical Chat and Provider contracts`
**Depends on:** MAT-470
**Blocks:** all backend/UI lanes

- Primary files: `packages/contracts/src/**`, focused contract tests, and shared
  fixture factories under `tests/**/fixtures`.
- Define strict Zod schemas for Chat/Turn/Run, Driver/Instance/model/options,
  normalized messages/activity, Provider readiness, `/` invocations, `@`
  resources, inspector projections, and safe errors.
- Include a temporary compatibility mapper for current Hermes conversations and
  coding-agent thread projections. Do not add storage or UI.
- Gate: schema bounds, redaction, round-trip, and fixture compatibility tests.

### MAT-472 — Owner-local Chat repository and transactional outbox

**Temporary assignee:** Yuhan
**PR:** `feat(gateway): add canonical Chat repository`
**Depends on:** MAT-471
**Blocks:** MAT-477, MAT-479, MAT-480

- Primary files: new `packages/gateway/src/chat/**`, shared owner-database
  migrations, Gateway shutdown wiring, and `tests/gateway/chat-*.test.ts`.
- Implement Kysely tables/repository, owner isolation, revisions, messages,
  Turns/Runs, one-active-Run constraint, idempotency, project mutation,
  outbox/replay, export/delete, and bounded cleanup.
- Reuse the Gateway-owned Kysely instance; no new pool, SQLite, ORM, or JSON
  authority.
- Gate: row-lock races, atomic outbox, delete/finalize races, owner isolation,
  and shutdown ownership tests.

### MAT-473 — Provider Driver/Instance catalog and Chat binding

**Temporary assignee:** Yuhan
**PR:** `feat(gateway): add Provider Instance catalog and Chat binding`
**Depends on:** MAT-471
**Blocks:** MAT-477 and MAT-476

- Primary files: new canonical Provider registry in
  `packages/gateway/src/chat/**`; adapt—not duplicate—existing
  `coding-agents/provider-registry.ts`, workspace provider config, and Hermes
  readiness seams.
- Project Drivers and Instances, model/option descriptors, capability classes,
  setup state, and stable Instance IDs through `GET /api/chat-providers`.
- Enforce draft freedom, atomic first-Turn Instance lock, compatible same-Instance
  model/options, and `provider_instance_locked` for later changes.
- Gate: duplicate IDs, readiness failure, capability mismatch, first-Turn race,
  same-Instance model change, and cross-Instance rejection tests.

### MAT-347 — Canonical execution-root provenance

**Temporary assignee:** Yuhan
**PR:** retain MAT-347's focused conventional title
**Depends on:** MAT-471
**Blocks:** MAT-477 and MAT-478

- Preserve the existing exact project/worktree provenance scope.
- Change only enough to emit the canonical `ChatExecutionRootRef` contract.
- Do not absorb file-diff, inspector, or worktree-management UI.

### MAT-477 — Canonical Turn/Run orchestration and first adapters

**Temporary assignee:** Yuhan
**PR:** `feat(gateway): orchestrate canonical Chat runs`
**Depends on:** MAT-472, MAT-473, and MAT-347
**Blocks:** MAT-479, MAT-478, and MAT-480

- Primary files: canonical Chat routes/orchestrator under
  `packages/gateway/src/chat/**` plus adapters around current Hermes and coding
  provider seams.
- Implement `/api/chats`, transactional Turn admission, Run attempts,
  cancellation, same-Instance resume, normalized events, root resolution, and
  generic errors. Start with Hermes, Codex, and Claude Code; add Pi only if it
  passes the same adapter contract.
- Provider calls occur after commit and cannot hold DB locks. No OpenCode or
  OpenClaw special-case path.
- Gate: real accepted turns per enabled adapter, retry/resume, cancellation,
  root change, late events, restart reconciliation, and cross-shell replay.

### MAT-479 — Legacy import and canonical cutover

**Temporary assignee:** Yuhan
**PR:** `feat(gateway): migrate legacy conversations to canonical Chat`
**Depends on:** MAT-472 and MAT-477
**Blocks:** MAT-483

- Import `system/conversations/*.json` and the single existing bounded
  `system/coding-agents/threads.json` authority. Never import renderer memory.
- Implement idempotent hashes, quarantine, maintenance barrier, explicit
  cutover marker, 90-day alias expiry, rollback guard, and no dual write.
- Gate: repeated/crashed import, changed source, invalid/symlink source,
  transcript parity, adapter-state isolation, exact-expiry clock, and old-writer
  refusal.

### MAT-458 — Typed Run activity contract and durable replay

**Temporary assignee:** Yuhan
**PR:** use the existing MAT-458 issue and keep it draft until human review
**Depends on:** MAT-349 and MAT-471
**Blocks:** MAT-474 integration, MAT-478, and MAT-483

- Keep Gateway normalization, redaction, ordering, persistence/replay, and
  Desktop projection adapters here.
- Do not own final timeline spacing/visual polish or exact changed-files truth.
- Rebase its contract onto MAT-471 rather than creating a second activity schema.

### MAT-476 — Shared Chat panel, composer, and controller

**Temporary assignee:** Yuhan
**PR:** `feat(desktop): add shared Chat surface and composer`
**Depends on:** MAT-471 and MAT-473; may use fixtures before MAT-477
**Blocks:** MAT-480

- Primary files: a new shared Chat feature boundary in
  `desktop/src/renderer/src/features/chat/**`; migrate useful behavior from
  `ChatTab`, `ProjectChatsView`, `AgentConversationView`, and composer pickers.
- Own active-Chat controller, empty/draft states, Provider/Instance/model/options,
  effort/mode/permissions, `/` skill/command picker, `@` resource picker,
  attachment/reference chips, stop/send, and responsive composition.
- Do not own message-part visual polish, inspector internals, or Gateway
  persistence.
- Gate: identical Global/Project fixture rendering, capability controls,
  first-Turn lock UX, keyboard navigation, draft preservation, and runtime reset.

### MAT-474 — Conversation message and activity presentation

**Temporary assignee:** Yuhan
**Suggested later owner:** Nima
**PR:** `feat(desktop): polish canonical Chat messages`
**Depends on:** MAT-471; final integration also depends on MAT-458
**Blocks:** MAT-483

- Primary files: `features/chat/elements/**`, a new shared
  `ConversationTimeline`, and focused Desktop tests.
- Own user/assistant messages, markdown/code, reasoning disclosure, streaming,
  tools, approvals, requested input, errors/retry, timestamps/actions,
  accessibility, and long-content performance.
- Develop against MAT-471 fixtures so backend work does not block presentation.
  Do not import `threads`, `hermes-chat`, or coding workspace stores directly.
- Gate: every canonical part type, streaming/reload parity fixtures, keyboard/
  screen-reader behavior, virtualization or bounded rendering, and narrow width.

### MAT-475 — Provider-neutral Chat inspector shell

**Temporary assignee:** Yuhan
**Suggested later owner:** Shubham
**PR:** `refactor(desktop): add shared Chat inspector shell`
**Depends on:** MAT-471; may use fixtures
**Blocks:** MAT-481 and MAT-483

- Primary files: refactor `AgentConversationInspector`,
  `AgentWorkspacePanels`, `AgentReviewPanel`, and inspector layout seams into a
  shared `ChatInspector`.
- Own panel layout, tabs, resize/collapse, responsive behavior, focus,
  loading/empty/error states, and fixture-driven context/Run/files/changes
  surfaces.
- Do not calculate exact diffs, read arbitrary paths, or own Chat routing.

### MAT-478 — Exact per-Turn changes and safe file-read backend

**Temporary assignee:** Yuhan
**PR:** `feat(gateway): persist exact Chat turn changes`
**Depends on:** MAT-347, MAT-458, and MAT-477
**Blocks:** MAT-481

- This is the backend half of MAT-460: capture/store bounded change truth,
  authorization, safe Git/file reads, concurrency labels, and canonical
  inspector projections.
- Preserve MAT-460's distinction between exact turn diff, checkpoint result,
  and current file. Reuse the single Chat repository/transaction queue.
- Gate: owner/root authorization, before/after isolation, reload, binary/rename/
  partial/concurrent cases, traversal/symlink denial, timeout, and output caps.

### MAT-481 — Changes/files inspector integration

**Temporary assignee:** Yuhan
**Suggested later owner:** Shubham
**PR:** `feat(desktop): integrate Chat changes and file preview`
**Depends on:** MAT-475 and MAT-478
**Blocks:** MAT-483

- This is the UI half of MAT-460: changed-files card/tree, structured diff,
  current/checkpoint labels, file preview, stale response identity, and loading/
  error states inside the shared inspector.
- Do not add a renderer artifact store or infer authorship from file events.
- Gate: all backend truth variants, reload parity, stale response cancellation,
  responsive inspector, and independent Git/hash comparison in final QA.

### MAT-480 — Merge Global and Project Chat domains

**Temporary assignee:** Yuhan
**PR:** `feat(desktop): unify Global and Project Chat`
**Depends on:** MAT-472, MAT-477, and MAT-476
**Blocks:** MAT-483

- Route Global and Project entry points into the same controller/surface and
  canonical Chat API.
- Implement Add to Project, Remove from Project, Move to Project, one Recents/
  search identity, stable breadcrumbs, and project-scoped resource search.
- Preserve history and `chatId`; reject moves during active Runs; do not rewrite
  recorded Run roots.
- Gate: create root/project Chat, move both directions, reload/reconnect,
  conflict and stale Project recovery, same layout/actions in both routes.

### MAT-483 — Full composition, legacy-rail removal, and real QA

**Temporary assignee:** Yuhan; Nima and Shubham verify their accepted surfaces
**PR:** `refactor(desktop): cut over to canonical Chat experience`
**Depends on:** MAT-479, MAT-458, MAT-474, MAT-481, and MAT-480
**Blocks:** MAT-364 completion and public docs

- Compose the accepted panel, timeline, and inspector; switch Desktop/browser
  Shell/CLI/channel projections to `/api/chats` and outbox replay.
- Remove renderer-owned identity and obsolete provider-specific rails only after
  import, parity, and rollback evidence. Do not delete owner legacy files.
- Gate: focused suites, production builds, exact-head authenticated owner-VPS
  turns for enabled Providers, Global/Project move, reload/reconnect, restart,
  terminal/file references, migration parity, export/delete, and screenshots.

### MAT-364 — Beta acceptance and hardening

**Current owner:** Nima for product acceptance coordination; Yuhan fixes backend/
panel defects; Shubham fixes inspector defects
**Depends on:** MAT-483 and resolution of MAT-468/#1299
**PRs:** one narrow bug PR per discovered issue; do not reopen the integration PR

- Run the launch matrix on a real authenticated disposable customer VPS and
  built Desktop, not fixture-only UI.
- File each unrelated bug separately with owner, evidence, expected behavior,
  and dependency. Human Review remains the user's gate.

### MAT-482 — Public Chat and Project Workspace documentation

**Temporary assignee:** Yuhan
**Repository/PR:** `FinnaAI/matrix-os-site`,
`docs(chat): document canonical Chat and Project workspaces`
**Depends on:** MAT-364 acceptance
**Blocks:** public launch claim

- Document user-visible Provider selection and lock behavior, Fork/New Chat,
  model/options, `/`, `@`, Project moves, resource ownership, setup/recovery,
  export/delete, and unavailable-state behavior.
- Keep the public repository free of customer identifiers, internal paths,
  credentials, private runbooks, and unshipped implementation details.
- Gate: documentation build, link check, screenshots from the accepted exact
  Desktop head, and behavior parity with the shipped runtime.

## Dependency graph

```text
MAT-470 architecture
└── MAT-471 contracts + fixtures
    ├── MAT-472 repository/outbox ───────────────┐
    ├── MAT-473 Driver/Instance catalog ───────┐ │
    ├── MAT-347 execution-root provenance ────┼─┼── MAT-477 orchestration
    ├── MAT-458 typed activity (after MAT-349)│ │       ├── MAT-479 migration
    ├── MAT-476 shared panel/composer ─────────┘ │       └── MAT-478 change truth
    ├── MAT-474 messages UI ─────────────────────┼──────────────┐
    └── MAT-475 inspector shell ─────────────────┘              │
                                        MAT-478 + MAT-475 ── MAT-481 inspector UI

MAT-472 + MAT-477 + MAT-476 ── MAT-480 Global/Project merge
MAT-479 + MAT-458 + MAT-474 + MAT-481 + MAT-480 ── MAT-483 cutover
MAT-483 + MAT-468 disposition ── MAT-364 real beta acceptance ── MAT-482 docs
```

## Parallel work lanes

After MAT-471 merges, four lanes can proceed without sharing implementation
files:

| Lane | Suggested later owner | Work | Integration input |
|---|---|---|---|
| Canonical backend + Chat panel | Yuhan | MAT-472/MAT-473, MAT-347, MAT-477/MAT-479, MAT-476, MAT-478, MAT-480/MAT-483 | Owns schemas after MAT-471, Gateway, controller, and final composition |
| Messages | Nima | MAT-474 | Consumes frozen schemas/fixtures; hands over pure timeline components |
| Inspector | Shubham | MAT-475 then MAT-481 | Consumes fixtures, then MAT-478 API; hands over pure inspector components |
| Activity contract | Yuhan, kept separate from UI | MAT-458 | Supplies normalized/reload-stable activity to messages and inspector |

Efficiency rules:

- Freeze MAT-471 before parallel UI coding. Contract changes require one short
  review from all three owners before merge.
- Each lane owns disjoint files. Cross-lane changes go through the owning PR,
  never by editing another person's branch.
- UI lanes use shared fixtures first. They must not wait for the full database
  or compensate with local persistence.
- Keep PRs stacked only on reviewed exact heads. Record the base SHA in the
  issue and PR description.
- Integrate once at MAT-483. Do not continuously merge three active feature
  branches into one shared branch.
- Test at public seams: contract fixture -> Gateway projection -> Desktop
  controller -> pure surface. Add real authenticated evidence at integration,
  not only at the end of every visual commit.
- Keep each Linear issue in `In Progress` and PR draft until the assigned human
  review boundary. The user controls Human Review completion.

## MAT-468 / PR #1299 disposition

Recommended answer: complete human review of #1299 as a short-term compatibility
slice because it already fixes the truthful “selected Provider executes the
turn” bug. If accepted, merge it before MAT-473 and preserve its tests, then wrap
its `hermes/codex/pi` field behind the new Driver/Instance compatibility mapper.

Do not make #1299 a dependency of MAT-471/MAT-472/MAT-473. It lacks owner-PostgreSQL
persistence and the full Instance contract. If human review rejects it, reuse
only its validated routing/readiness patterns in MAT-473/MAT-477 and close it without
forcing an unnecessary merge. Either path converges at MAT-483.

## Remaining Linear cleanup after team review

The new issues, temporary Yuhan assignments, parents, and implementation
blockers are in place. Keep these follow-ups separate from task creation:

1. When Nima and Shubham choose work, change only the selected task assignees;
   keep the contract and blocker graph unchanged.
2. Remove MAT-321's stale blocker relation from completed MAT-322 after the team
   confirms the new split.
3. Reconcile MAT-459 from `PR In Review` to the state matching merged PR #1294.
4. Record the accepted #1250 head for MAT-458 before implementation and consume
   MAT-471 rather than introducing another activity contract.
5. Treat MAT-460 as the umbrella for MAT-478 and MAT-481 while preserving
   MAT-347/MAT-458 dependencies.
6. Use separate narrow issues for MAT-364 acceptance findings; do not expand
   MAT-483 or reopen its integration PR for unrelated bugs.

## Final acceptance checklist

- [ ] One Chat identity and API power Global and Project entry points.
- [ ] The first accepted Turn locks the exact Provider Instance; later changes
  offer Fork/New Chat instead of silently switching execution state.
- [ ] Model/options/mode/effort/permissions render only from current capabilities.
- [ ] `/` skills/commands and `@` resources are typed and owner-authorized.
- [ ] An idle Chat moves between Projects without history or identity loss.
- [ ] Files, Apps, Terminal Sessions, and Tasks retain their canonical owners;
  Chat stores safe references only.
- [ ] Timeline and inspector render the same live, reload, and reconnect truth.
- [ ] Owner-local PostgreSQL, migration, outbox, delete/export, and shutdown
  invariants pass focused tests.
- [ ] Enabled Providers complete real authenticated owner-VPS Turns; unavailable
  Providers fail closed with safe setup actions.
- [ ] Built Desktop evidence covers wide/narrow layouts, keyboard/accessibility,
  Global/Project parity, and known-bug regressions.
- [ ] The separate `FinnaAI/matrix-os-site` documentation PR matches the
  accepted runtime and passes its own build/link checks.
- [ ] Linear/PR states, exact heads, checks, and human-review ownership are read
  back before any review, merge, or launch claim.
