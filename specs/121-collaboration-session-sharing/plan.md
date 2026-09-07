# Implementation Plan: Collaboration and Session Sharing

**Branch**: `codex/121-collaboration-session-sharing` | **Date**: 2026-09-07 | **Spec**: [spec.md](spec.md)
**Input**: `specs/121-collaboration-session-sharing/spec.md` and the approved incremental delivery sequence.

## Summary

Deliver four usable internal milestones: shared Chat discussion, shared AI, shared Terminal, and whole-project sharing. Six implementation PRs merge safely into main with capabilities dormant until the milestone's complete authorization, recovery, UI parity, and two-account evidence passes. Internal rollout is independent of public availability. Whole-project sharing remains all-or-nothing.

Reuse canonical Chat history, queue, outbox, and per-member state; add a common owner-local collaboration authority and narrow actor-preserving platform ingress. Preserve existing terminal session identity through a scope-runtime adapter, proving native execution isolation before enabling shared input. Use project-owned state adapters and a guarded migration journal for final whole-project cutover.

The detailed work breakdown, acceptance gates, and dependency graph are in [delivery-plan.md](delivery-plan.md). These are proposed PR boundaries, not already-created implementation PRs or a commitment to completion dates.

## Technical Context

**Language/Version**: TypeScript strict ES modules, Node.js 24+; existing shell/native React surfaces.
**Primary Dependencies**: Existing Hono, Zod 4 (`zod/v4`), Kysely, PostgreSQL, canonical Chat/Provider V3 contracts, WebSockets, xterm/Zellij, native systemd supervision. No new ORM, queue service, or CRDT.
**Storage**: Owner-controlled Postgres for collaboration authority, Chat and project app state; files for identity/config, owned project files, terminal exports/checkpoints; platform Postgres for content-free routing/discovery and rollout policy.
**Testing**: Vitest with real-Postgres race/integration fixtures; existing Web/Electron harnesses; applicable native mobile tests; real isolated VPS-native execution/terminal probes. TDD precedes runtime changes.
**Target Platform**: VPS-native Linux runtime; Web Canvas, Web Desktop, Electron Desktop, Web Mobile, Native Mobile, CLI as applicable.
**Project Type**: Existing multi-package OS with platform routing, gateway, shared contracts, and multiple renderers.
**Performance Goals**: Eight members/scope; 32 pending requests/Chat; 95% of Chat/terminal live updates within 2s; control transfer within 3s; invite/accept/open within 3min excluding provisioning; connections closed within 60s of revoke, new access/writes rejected immediately at authoritative commit.
**Constraints**: Owner/editor/viewer only; one active AI request per Chat; one terminal controller; no implicit parent/sibling access; no partial project share; no owner impersonation; no private drafts in shared records; no new billing or document collaboration product.
**Scale/Scope**: Four milestones in six planned implementation PRs, with four site documentation updates alongside releases. Contracts, backend wiring, UI and tests are combined where reviewable to reduce CI overhead. Split further only when actual reviewability or repository limits require it. PR2 execution and PR5 project foundations remain disabled until their consumer milestones complete.

## Constitution Check

Pre-research and post-design gate result: **PASS for the proposed design**. This is not runtime certification. No constitutional exception is requested; execution compatibility proofs remain mandatory before enabling M2/M3.

| Principle | Design and evidence gate |
| --- | --- |
| I. Owner data | Owner Postgres/content remain authoritative; platform stores routing metadata only; scope export/delete and backup paths stay available during rollout rollback. |
| II. AI kernel | Canonical orchestration and provider adapters remain execution entrypoints. Scope/actor authorization constrains their context; no second AI backend. |
| III. Headless multi-shell | Common contracts/authority; UI is a projection; milestone completion includes each applicable named surface. |
| IV. Recovery | Additive migrations, outbox reconciliation, fenced transitions, backups, failure-injection and restart tests. |
| V. Quality | Each enabled milestone is a complete bounded experience with honest disabled states. Security is never a deferred hardening phase. |
| VI. App ecosystem | M4 adapts the existing app bridge to project scope; no personal app data or credential copying. |
| VII. Ownership scopes | Effective direct or inherited membership is singular; user identity remains distinct from resource owner; no silent organization sharing. |
| VIII. Defense in depth | Exact auth/route matrix, validation, bounded resources, current membership checks, execution isolation and shutdown below and in contracts. |
| IX. TDD | Each PR has red/green contract, race, failure and integration tests; isolated runtime spike before committing to harness compatibility. |
| X. Worktree/PR review | All future implementation slices use manual worktrees and Conventional Commit PRs; required checks and current-head Greptile 5/5 before merging. |
| Documentation | Separate `FinnaAI/matrix-os-site` `content/docs/` PRs accompany milestone releases as documentation deliverables, without gating implementation merges or internal enablement; no docs claim for unavailable later milestones. |

The setup script only recognizes numeric feature names. Run it and agent-context tooling with `SPECIFY_FEATURE=121-collaboration-session-sharing`; keep the actual git branch's required `codex/` prefix. The optional before/after planning auto-commit hooks are disabled by project configuration; normal reviewed commits publish this plan.

## Project Structure

### Documentation (this feature)

```text
specs/121-collaboration-session-sharing/
  spec.md
  plan.md
  delivery-plan.md
  research.md
  data-model.md
  quickstart.md
  contracts/collaboration-api.md
  contracts/realtime-execution.md
  checklists/requirements.md
  checklists/planning.md
```

`tasks.md` is intentionally reserved for `/speckit-tasks`. This command defines PR boundaries and design artifacts; it does not create implementation branches, issues, deployments, or GitHub milestone objects.

### Source Code (repository root)

Existing anchors; `(new)` entries are proposed boundaries, not claimed files:

```text
packages/contracts/src/canonical-chat*.ts
packages/contracts/src/collaboration*.ts                 (new)
packages/gateway/src/collaboration/                     (new authority/adapters/wiring)
packages/gateway/src/chat/{database,repository,queue-repository,orchestrator}.ts
packages/gateway/src/chat/{routes,event-stream,event-websocket-route}.ts
packages/gateway/src/shell/{ws,routes,terminal-lease,registry}.ts
packages/gateway/src/{request-principal,auth,project-manager,agent-sandbox}.ts
packages/platform/src/collaboration/                    (new directory/proxy/policy)
packages/platform/src/{session-routing-proxy,session-routing-middleware,session-routing-websocket}.ts
packages/platform/src/{ws-upgrade,customer-vps-preview}.ts
packages/ui/src/collaboration/                          (new common controls/projections)
shell/src/{components/ChatApp.tsx,hooks/useCanonicalChatState.ts}
desktop/src/renderer/src/features/chat/
apps/mobile/lib/{requests,queries}/
packages/sync-client/src/                               CLI adapter
scripts/spikes/collaboration/                           (new bounded evidence harness)
distro/customer-vps/                                   scope-runtime service/profile
tests/gateway/                                         authority/chat/terminal tests
tests/platform/                                        routing/proof tests
tests/shell/                                           shared behavior tests
tests/e2e/                                             named-surface full journeys
```

**Structure Decision**: Resolve dependencies in focused registration modules. Extract seams before adding behavior to 1000+ line composition files; target focused modules below 500 LOC. Do not copy a second transcript, queue, membership service, or business derivation into each renderer. A new shared UI folder composes existing canonical Chat components rather than replacing them.

## Architecture and Security

### Authority and routing

1. A signed-in actor discovers a scope through platform metadata or opens an authenticated invite link.
2. Platform resolves the scope to a registered owner runtime, checks rollout eligibility, and proxies only the exact collaboration route family. It signs actor/runtime/scope/method/path/expiry claims; it never forwards the owner's general token to the participant.
3. Gateway validates the proof and current scope membership/role, resolves the resource owner separately, and supplies a typed `AuthorizedCollaborationContext` to an adapter. No fallback to configured owner is permitted.
4. The adapter reads or commits against owner storage. A durable outbox publishes scoped events after commit. Every recipient and replay batch is authorized against that same scope, including inherited project membership.
5. Directory metadata is eventually reconciled from the owner outbox. Stale discovery may show unavailable; it can never grant access. The platform stores no transcript, terminal replay, or project content.

All external, owner, invitation, discovery, proxy, runtime, and live routes are enumerated in [contracts/collaboration-api.md](contracts/collaboration-api.md). Ordinary owner routes stay owner-only. They must nevertheless check shared resource state so owner legacy Chat/terminal routes cannot bypass rollout, control, or scope gates.

### Execution boundary

M1 has no shared execution. Shared resources reject AI start/queue dispatch/steer/retry through every path, including owner legacy clients. Conversion waits for existing activity to settle and atomically fences future personal dispatch.

M2 uses scoped adapter context and fresh scope-bound resume provenance. Native child processes run as non-root in isolated filesystem/process/network namespaces through a fixed-profile system supervisor, with scope-local storage and brokered approved services only. Personal home, global kernel memory, host environment secrets, owner credentials, Docker/agent sockets, and DB connections are absent. Existing access-source policy is invoked in the trusted broker without lending its credentials to collaborators. Credentials that cannot be safely brokered make that adapter unavailable.

M3 launches eligible sessions in that native boundary from the start, attaches the same session after sharing, and requires actor/role plus lease epoch on all input paths. Existing unrestricted personal sessions cannot be retroactively made safe by changing cwd or attaching through a new socket. A failed eligibility check leaves the existing terminal private and intact.

M4 expands the scope to a complete isolated project root and project app state. The full inventory must pass compatibility checks. Details and required real-host proofs are in [research.md](research.md) and [contracts/realtime-execution.md](contracts/realtime-execution.md).

### Runtime startup and dependency ownership

Proposed registration functions/factories are implementation targets:

1. Platform initializes existing owned Kysely, `createCollaborationDirectory(db)`, `createCollaborationPolicy(db)`, and `createCollaborationProxy(registry, proofSigner, policy)` before registering exact HTTP/WS paths. It injects keys through existing secret/config channels; no secret in URLs or logs.
2. Gateway initializes existing owned Kysely and additive collaboration/Chat migrations. `createCollaborationRepository(db)` and `createCollaborationAuthority(repository, policyVerifier, clock)` share that pool without owning its shutdown.
3. Register canonical resource adapters after verifying Chat repository, project resolver, app bridge, and session registry dependencies. Missing adapters advertise unsupported capability and cannot grant partial project access.
4. Initialize `createCollaborationCommandDispatcher(authority, adapters)`, scoped event delivery, bounded connection registry, and directory-outbox worker. Resource and policy recovery runs before admitting shared mutation/dispatch.
5. Only M2/M3-ready hosts initialize `createScopeRuntimeClient(fixedSocket, profileCatalog)` after the system supervisor reports the exact supported isolation profile. Gateway cannot provide arbitrary shell, filesystem root, or service-unit configuration to that supervisor.
6. Register collaboration routes with validated actor middleware, body limits, typed Zod contracts, and current action authorization. Inject collaboration authority into legacy shared-resource mutation seams as well. No `globalThis` integration.
7. Shutdown stops admission, releases input control, fences dispatch, notifies/drains sockets, checkpoints accepted state, stops workers/timers and bounded broker calls, then destroys pools only in their owning gateway/platform close path. Zellij process continuity is governed by the session service, not by an observer disconnect.

### Atomicity, migrations, and project cutover

Database writes involving grants, resource revisions, and outbox are one transaction. Lock scopes by ascending ID, then resource rows, then request/decision rows. Enforce submitted revision in the write or hold the row lock; use unique keys and idempotent conflict handling. Membership/capacity checks and mutations share the lock. No external network call occurs inside DB transactions.

Outbox consumers reconcile at least once by event ID. Dispatch commands carry scope epoch and run attempt; adapters reject stale commands. If the external outcome is uncertain, expose interrupted/unknown and reconcile without automatically repeating a side effect. Existing provider recovery rules remain authoritative; this is not a new running-agent revocation policy.

Files/app-state cutover uses a durable journal: `prepared -> staging -> fenced -> committing -> active`, or `failed/recovering`. All source writers and run admissions, including CLI and legacy paths, honor the fence. Stage bytes outside DB transactions. Under the final version check publish authority and membership once; a temporary inaccessible state is acceptable, two writable authorities are not. Reconcile a crash from the declared generation/commit marker, retaining the original as backup until verified. Untracked writes or an unmovable project-owned terminal cause a clean block before activation. See [data-model.md](data-model.md).

All schema changes are additive/versioned. Backfill genuine known actors only; use a labeled unknown historical author otherwise. Older clients cannot act on shared resources through legacy routes. Rolling back to a binary that ignores collaboration fences is prohibited; rollback uses capability modes or a proven compatible binary, preserving new tables and content.

### Resource limits, timeout, and cleanup defaults

| Resource | Initial bound / handling |
| --- | --- |
| Members and invitations | Owner + 7 slots per scope, pending+accepted counted; expired/revoked excluded; no eviction of live members. Invite expires after 7 days. |
| Scopes and operations | 100 active scopes/owner and 20 pending invitations/recipient; 10 invite/share operations/minute/actor; explicit capacity error. |
| Shared Chat queue | 32 pending; one active; 64 KiB text request; actor-scoped request ID and payload hash. |
| HTTP | 96 KiB bodyLimit on all mutation verbs including DELETE; explicit 2 MiB file-upload exception; smaller operation schemas; finite pagination max 100. |
| Network calls | 10s API/proof/directory/broker request; 30s file transfer chunk; redirects denied or each destination revalidated and pinned. |
| Connections | 256/gateway, 32/scope, 4/actor/scope; refuse excess, never evict memberships. Heartbeat 10s; stale after 30s; sweep every 5s. |
| Live buffers | 64 KiB frame; 1 MiB outbound/socket; 2 MiB terminal replay/session; slow recipient receives refresh/close. Scope event history 24h or 10,000 records, whichever first; never send owner-wide cursors. |
| Proof/policy | Request proof max 30s; no content bearer capability; signed cohort policy max 30s; expired policy disables new participant operations. Owner recovery remains available. |
| Control | 30s lease, renew at 10s; mandatory epoch per input/paste/resize; 5s stale sweep. |
| Database | 2s lock acquisition and 5s statement timeouts for ordinary mutations; chunk maintenance jobs; retry bounded conflicts at most 3 times. |
| Audit/idempotency | Content-free audit 90 days, operation replay metadata 7 days; completed Chat history remains under existing retention, not audit expiry. |
| Staging/temporary files | Expired unreferenced staging swept hourly after 24h; `lstat`, skip symlinks, recheck journal reference before deletion; active transition and backup references protect content. |
| Shutdown | 10s admission/drain deadline; no closing injected pools; unfinished work retains recoverable state. |

These initial operational values require representative-load validation. They may be tightened server-side without changing roles or weakening scope. Stream batches check authoritative membership before sending; stale-connection sweeps are cleanup, not a permission cache. Existing binary terminal frames may use smaller protocol-specific bounds.

## Delivery, Test Strategy, and Rollout

[delivery-plan.md](delivery-plan.md) is the milestone/PR source of truth. [quickstart.md](quickstart.md) describes internal acceptance, evidence, and rollback. Every milestone has authorization, revoke, restart, and applicable-surface evidence before enablement. Tests are included with each behavior PR rather than relegated to a final PR.

Required coverage: schema/contracts; real-Postgres invite limits and revoke/write races; platform proof tampering and route escape; owner legacy bypass; event replay privacy; actor-specific private state; concurrent queue admission and approvals; native execution escape attempts; terminal lease fencing; project cutover failures; export/delete boundaries. New kernel/gateway logic targets 99–100% coverage under repository policy, with documented uncovered branches treated as review findings.

Modes are `off`, `internal`, `enabled`, and `read_only`, separately for each milestone. Effective availability is the intersection of server policy, runtime capability/version, scope readiness, role, and prerequisite milestone state. Initial policy is off. Internal access requires every invited participant to be in the approved cohort. Removing a participant or disabling a capability invalidates connections and rejects commands; owner revoke/export/recovery is always available through the owner route.

M1 discussion-only is an explicitly approved internal delivery phase, not final P1 completion. M4 remains unavailable until files, apps/data, layout, Chat, Terminal, and lifecycle work together for the complete inventory. No phase changes owner/editor/viewer roles or introduces document coediting, partial sharing, new billing, or follow mode.

## Phase Outputs and Readiness

- Phase 0 complete: [research.md](research.md), with observed code seams, decisions, alternatives, and runtime proof gates.
- Phase 1 complete: [data-model.md](data-model.md), [HTTP/auth contracts](contracts/collaboration-api.md), [realtime/execution contracts](contracts/realtime-execution.md), [quickstart.md](quickstart.md).
- Phase 2 planning complete: [delivery-plan.md](delivery-plan.md) identifies independently mergeable PRs and usable milestones. `/speckit-tasks` may expand each PR into implementation tasks later; none are implemented here.
- Post-design constitution gate: pass with no exception. Provider/native isolation support must be demonstrated by the planned spikes before its implementation/enablement gates can pass. The existing local `integrations-mcp` build issue affects repository validation, not a claimed successful runtime experiment.

## Complexity Tracking

No constitution violation is required. The owner-local grant authority, platform metadata index, native scope supervisor, and transition journal each address a distinct trust or recovery boundary. Their explicit interfaces prevent ad-hoc machine access and duplicated per-app grants. Four milestones keep these dependencies independently reviewable and testable.
