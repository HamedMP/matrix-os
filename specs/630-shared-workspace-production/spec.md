# Shared workspace production rollout

Ticket: [ENG-319](https://linear.app/matrix-os/issue/ENG-319/validate-immediate-shared-desktop-with-disposable-cloudflare-compute). Builds on [spike #2703](https://github.com/HamedMP/matrix-os/pull/2703), dependencies #2704 and runtime #2705.

## Goal and journey

New owners open their saved Web Desktop immediately. Shared Postgres/R2 APIs serve data while an owner-isolated Cloudflare container starts in the background. Agents retain durable work leases while running, waiting for tools or inference, and disconnected from clients. Completion checkpoints data before the idle timer destroys compute. Owners can also select their personal VPS; existing VPS billing, routing and data remain authoritative for those machines.

Free and Starter are proposed shared-compute tiers. Exact public allowances and prices require a product decision; initial implementation uses explicit server-provisioned compute policies rather than inferring entitlements from UI or billing labels. Compute accounting is independent from the existing authoritative Matrix AI funding ledger. A compute allowance never grants inference credit.

## Architecture and invariants

- Postgres owns owner placement, revisions, jobs, reservations, session associations and lifecycle fencing. R2 holds immutable file/checkpoint bytes. Durable Objects coordinate each owner and schedule alarms; Queues deliver work. No D1 or application SQLite.
- Resolve execution credentials for the authenticated owner and generation immediately before container startup. Never fall back from a missing production owner credential to the isolated preview's database or AI key. Secrets remain absent from images, checkpoint records and browser responses.
- Reserve maximum task time atomically before admitting compute. Repeated delivery does not reserve or execute again. Completion settles actual bounded elapsed time; uncertain termination retains the reservation until reconciliation. Denied compute leaves saved data readable.
- Associate shared Chat identity with the actual gateway SDK session through trusted runtime state. Browser-supplied SDK IDs never select sessions. Persist associations before checkpoint and resume only the matching Chat.
- One owner per container; an idle owner has zero running containers. A personal placement cannot be claimed, paused or destroyed by pooled lifecycle paths. Shared-to-personal migration needs a fenced, verified data handoff before routing changes.
- Public rollout stays disabled until owner credential isolation, quotas, durable synchronization, account export/deletion, native archive retention, realtime recovery and all affected OS views are qualified.

## Auth matrix and limits

| Boundary | Authority | Public | Bounds |
| --- | --- | --- | --- |
| Saved workspace APIs | Fixed Clerk issuer/audience, owner from verified token | no | Existing Zod/body limits, owner predicates and revision CAS |
| Queue delivery | Cloudflare queue binding; revalidate owner/job payload | no | One active job/owner; bounded retry and hard task deadline |
| Runtime credential resolver | Injected server authority, exact owner + generation | no | No client credential/endpoint input; fail closed, bounded lookup |
| Compute admission | Server-owned owner policy in Postgres | no | Atomic reservation; no negative allowance or duplicate debit |
| Personal VPS routes | Existing platform machine ownership and entitlement | no | Existing production checks unchanged |

No new public endpoint is introduced by the first three layers. Future route additions require extending this table, request size/schema/timeouts, explicit CORS and browser WS auth before implementation.

## Implementation units / native GitHub stack

Each unit ships as a separate native stacked PR, tests first. Plan changes are separate from implementation progress. Target <1,000 additions/20 files per layer; split before 3,000 additions/50 files.

### U1 — Owner-scoped runtime credentials

Goal: remove accidental shared credential fallback as the production multi-owner foundation.
Files: `packages/workspace-worker/src/runtime/credentials.ts`, native driver, Durable Object composition, Worker composition and focused credential/native tests.
Approach: injected typed resolver receives owner/generation; explicit preview resolver accepts only the configured preview owner; production resolver must be supplied, no implicit default. Resolve before any container operation; validate returned identity and required values. Bound credential lifetime to task execution. Clear references on teardown and redact resolved values from diagnostics.
Patterns: existing gateway owner credential saver, runtime generation fence and native driver injection.
Tests: owner A/B isolation, absent/mismatched/expired resolver results, no startup on denial, preview compatibility, errors redact resolved secrets, checkpoint/stop cleanup.
Verification: focused credential/native/entrypoint tests and Worker TypeScript.

### U2 — Durable compute reservations

Goal: enforce server-provisioned Free/Starter compute ceilings without relying on a browser or inference ledger.
Files: new `data/compute-budget.ts` and `tests/workspace-worker/data-compute-budget.test.ts`; integration into admission is a dependent layer.
Approach: own typed Postgres tables and Kysely repository; explicit owner policy/billing period; transaction + owner policy lock; idempotent job reservation with amount fingerprint; settlement capped by reservation; no permissive default; unresolved holds stay held. Policy provisioning is server-only and never exposed to workspace data requests.
Patterns: `data/runtime-store.ts` owner row lock, existing platform funded reservations (reuse semantics, never duplicate inference credit).
Tests: absent/expired policy, exhausted allowance, duplicate reserve/settle, mismatched duplicate, concurrent admission, owner and period isolation, downgrade with live reservations, actual elapsed clamp and unresolved holds.
Verification: PostgreSQL-compatible fixture tests; real Postgres concurrent admission before rollout.

### U3 — Trusted Chat session continuity

Goal: resume actual gateway SDK sessions after container replacement rather than starting every task fresh.
Files: new bounded runtime session helper, `runtime/control.mjs`, `runtime/result.mjs`, focused result/session tests.
Approach: read trusted Chat-to-SDK-session association from private runtime state, pass `sessionId` to the actual message API, extract actual init/result session identity, persist atomically before successful completion. Validate IDs and metadata; fail closed on corrupt/mismatched state; exclude keys/tokens. Bound record count/size and use symlink-safe paths. This is runtime identity/config state, not a second Chat/app datastore.
Patterns: gateway message schema + dispatcher V1 `resume`, atomic runtime file writes, result event parser.
Tests: first turn, same Chat resume, different Chat isolation, destroyed/restored home, invalid IDs and symlinks, truncated result and conflicting session IDs, bounded history.
Verification: focused helper/result tests; actual two-turn gateway/SDK destroy/restore test in a later isolated staging run.

### Dependent delivery units

- U4: Wire atomic reservation/outbox admission and settlement into Worker/Queue/lifecycle, with account deletion and plan authority. Preserve unknown holds on crash; bounded reconciler fences compute before release.
- U5: Production per-owner credential broker using platform funded short-lived access and isolated kernel databases; qualify two real owners with no cross-access.
- U6: Canonical Chat/Terminal reconnect transports, server events, explicit interactive leases and real agent resume validation. A disconnected browser never cancels work; terminal activity has a bounded lease.
- U7: Generic durable file/app synchronization with conflict handling, app Postgres ownership, checkpoint archive retention, export/deletion and restore reconciliation.
- U8: Shared/personal placement selector and new-user routing across Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile. Shared presentation uses one contract and derivation; personal routing stays intact. No automatic data migration in selector UI.
- U9: Upgrade data handoff: freeze shared writers, verify owner dump/files, import into disposable personal VPS, verify contents and credentials, atomically cut over routing; retry/rollback before cutover.
- U10: Compile runtime startup, qualify smaller shapes, load/reliability and cost tests, alarm/queue/lease recovery; diagnose the spike's unresolved failed execution. Cloudflare services wherever suitable; existing Postgres and VPS paths remain supported.
- U11: Separate documentation PR in `FinnaAI/matrix-os-site/content/docs`, linked to this stack; revise existing preview docs #264 into released behavior only after validation. Product/engineering stakeholder review is recommended before release; no additional approval gate has been requested.

## Acceptance and rollout

Use isolated staging Cloudflare resources and actual Matrix gateway/agents. Capture Web Desktop using the in-app browser; no external browser automation. Verify saved reads with compute stopped, two owners, same-Chat resume over destroy/restore, model/tool waits, client disconnect, hard cancellation, quota exhaustion, duplicate delivery, crash reconciliation, native archive cleanup, owner export/deletion and shared→personal handoff. Validate all affected OS views before enabling signup. Require current-head Greptile 5/5 and applicable CI for every layer; no customer rollout or merge is implied by this implementation plan.

Risks: 74s measured cold start, 1.20GiB sampled memory versus 6GiB provisioned, large images/checkpoints, incomplete app sync and one unresolved failed spike job. Container-only price estimates exclude AI, database, baseline and network costs. Do not promise an almost-free plan until the complete measured cost and abuse controls support it.
