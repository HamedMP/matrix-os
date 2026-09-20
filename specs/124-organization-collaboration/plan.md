# Implementation plan: organization collaboration

**Branch:** `codex/org-collaboration-spec` · **Date:** 2026-09-20
**Spec:** [spec.md](spec.md) · **Tasks:** [tasks.md](tasks.md) · **Agent handoff:** [sol-runbook.md](sol-runbook.md)
**Baseline:** freshly fetched `origin/main`, `94985f02eeb2c39ad337b144778db35d0b66c393`.
**Status:** Planning complete for review. No implementation, deployment, billing activation or external publication performed.

## Summary

Extend the existing collaboration system with Clerk-backed organizations, dynamic org/group audiences, a single resource authorization evaluator, standalone app/file/folder sharing, durable org ownership, organization administration and explicit Stripe/funded-AI payer accounts. Preserve current direct-user collaboration, 525's normal session UI, public snapshots and personal subscriptions.

This is a multi-stack feature, not a small addition to the Share dialog. An eight-person direct member table, personal-only runtime/billing lookup and existing unmounted resource adapters cannot satisfy the requested behavior by adding an org selector. [research.md](research.md) records verified seams and rejected shortcuts.

## Technical context

**Language/Version**: TypeScript strict/ESM, Node 24+, Zod 4; pnpm 10.33.4 installs and bun runs scripts.
**Primary Dependencies**: Hono, Kysely/Postgres, existing Clerk backend/session integrations, existing Stripe client, Matrix client/server APIs, Next.js/React/shared UI, Electron and Expo adapters.
**Storage**: platform Postgres for identity projections, groups, discovery, runtime ownership and billing; owner/org Postgres for resource grants/canonical resource data; owner files/R2 for bytes and recovery.
**Testing**: Vitest/unit + real Postgres race/migration tests, Playwright surface journeys, native Jest, disposable VPS-native acceptance and provider sandbox probes.
**Project Type**: Multi-package headless platform/gateway with Web/Electron/Expo/CLI clients.

**Target Platform**: Web Canvas, Web Desktop, Electron Desktop; Web Mobile and Native Mobile where the capability exists; CLI and sync daemon; VPS-native gateway/shell/runtime.
- **Performance/scale:** dynamic paginated membership, no per-member grant fanout. Preserve eight-person personal direct sharing and existing socket caps; proposed new limits live in the contract. Revocation deadline is a measured release gate.
- **Constraints:** no personal credential transfer, public resource access, alternative ORM, silent owner/payer change or direct Matrix-room bypass.

## Product decisions made explicit

1. **US1 (P1): organizations/groups.** Every member may share resources they own with current/future org or group members. Clerk is the only org membership authority. Local groups are subsets, not alternate organizations.
2. **US2 (P1): common sharing.** Existing Chat/project/terminal sharing gains audiences and effective-access explanations. Direct people still accept invitations. Viewer/editor rights and owner/admin controls remain separate.
3. **US3 (P1): apps/files/folders.** Share one live app instance/data, exact file or descendant folder. Existing shared project/folder inheritance wins over child grants; moves require confirmed access impact.
4. **US4 (P1): org administration/ownership.** An admin sees org-related sharing and manages org-owned resources; an employee's private content remains private. Org storage and authority survive creator departure.
5. **US5 (P1): org billing.** Admin-approved sponsorship selects the payer; Stripe customer, entitlements, AI budgets and ledger attribution are separate from actor/resource owner. No new price is invented.
6. **US6 (P2, still required for full delivery): Matrix groups.** V1 uses service-only Matrix Spaces/group rooms behind fresh Matrix OS group access, with text-only communication. Users are not directly joined to these rooms. Direct Matrix client participation remains disabled pending a stronger enforcement design. This is an explicit refinement of the draft's membership-mirroring wording, needed to make outage-time revocation enforceable.

## Architecture and runtime wiring

```text
Clerk membership/role API ──> platform org projection + freshness resolver
                                      │
             org/group commands ──> epoch/denial fence + audit/outbox
                                      │
UI / native / CLI actor ──> platform request proof + audience discovery
                                      │
                          owner/org gateway grant evaluator
                                      │
              Chat / terminal / project / app / file / folder adapters
                                      │
                         commit + scope audit/outbox
                                      │
                         current-authorized stream recipients

Explicit org sponsorship ──> payer account/entitlement ──> atomic AI reservation
Org group text ──> platform group authorization ──> service-only Matrix room
```

Register dependencies once: bootstrap platform DB/migrations, Clerk client and org resolver, org repositories/command/outbox services, typed runtime owner resolver, collaboration proof/discovery, billing sponsorship, then routes. Gateway registers owner DB, V2 grant resolver, platform evidence client, resource adapters, and finally routes/sockets. A missing dependency yields unavailable, not a permissive fallback. Shutdown stops admission/workers, drains/invalidates subscriptions and leases, cancels timers/requests, and closes only owned pools.

All ingress preserves actor separately from selected org/runtime. Existing app sessions and 24-hour sync JWTs authenticate identity only; they do not cache membership rights. New shared resource requests use the narrowly allowlisted collaboration path, not owner-home HTTP forwarding or a generic owner token.

### Freshness and revocation

Use a maximum 20-second membership evidence deadline anchored to upstream request start; issued proof expiry is clamped to that deadline. Every org authorization consults current platform denial/generation state; streams check before each batch/input and on a five-second watchdog. Queue claims and tool side effects reauthorize. A lost invalidation message cannot prolong a stale lease. Matrix OS-initiated org removal installs a local deny fence before the Clerk request and remains denied on an ambiguous remote outcome.

S00 must establish observed Clerk consistency/limits and exercise missed-event/outage behavior. Do not claim a hard Clerk-side 60-second SLA from webhook delivery. If the required external-change bound cannot be demonstrated with the supported authoritative API, org rollout remains blocked for that capability until its verification mechanism or product promise is explicitly resolved. Runtime-local revocation and denial-fence completion have separate audit timestamps from the provider event.

Mutation services use the recorded fixed-deadline permit protocol in data-model.md, keeping long work inert until fresh final publication authority is obtained. They recheck authorization/epochs under the existing scope lock and in their final conditional writes. Revocation completion waits for applicable runtime invalidation acknowledgement or permit expiration; it cannot be reported on enqueue alone. Already admitted external effects may finish, but no later broker step/queue admission uses the expired grant. No promise to recall downloaded bytes or already-started outside side effects.

### Ownership, billing and recovery

`user_machines` gains typed owner fields; `clerk_user_id` remains a nullable personal compatibility projection. Runtime slot uniqueness, provision locks, Cloud-init identity, backup keys, recovery metadata, routing and funded credentials all use that typed owner. Org runtime members enter authorized resource surfaces; org membership does not grant root/owner-home access. Members cannot enter the generic owner shell/gateway or receive its session token. Administrative shell access requires a separate short-lived org-admin runtime capability with an audited endpoint allowlist; it is never derived from org membership alone. Test owner-home, general files, terminal creation and generic bridge bypasses explicitly.

Explicit transfer copies only selected owned data to an org runtime behind the existing staged/fenced transition pattern. Never move personal credentials, private drafts or implicit provider sessions. Keep the source authoritative until a generation-checked cutover; retain an inaccessible backup afterward. New work requiring unsupported org execution stays unavailable. Transfer and sponsorship are distinct approvals/state transitions.

Payer accounts backfill personal subscriptions. Org checkout uses configured, approved catalog prices; absence of config is a truthful unavailable state. Billing and AI credit webhooks retain idempotency and monotonic projections. Payment failure blocks only sponsored new spend/runtime entitlements under the defined grace policy; preserve data/export/recovery and never fall back to a personal card.

### Resource and migration behavior

- V2 grants become the only allow source for a migrated scope. Existing member rows and directory indexes are projections, never fallback authorization.
- Legacy sync grants retain exact operation ceilings: viewer read; editor read/write; legacy admin additionally delete content, never reshare/manage/own. A path import must distinguish a file from a folder and resolve immutable identities; ambiguous entries remain blocked with an owner-visible report.
- Files use a stable owner catalog and normalized safe relative paths. Ordinary REST/agent/app/sync writers must honor the same move/transfer fence. Shared download bytes are gateway mediated; staging uploads become visible only through authorized commit.
- Standalone apps reuse sandbox/bridge restrictions and instance data isolation; a viewer cannot mutate through an app's internal controls or network bridge. The existing project file/app factories require explicit production routing/wiring before whole-project sharing is considered complete.
- Shared reads, search, thumbnails, exports, attachments, streams and all writes apply the same boundaries. No catalog/browser link itself confers access.

## Source structure and ownership

New focused modules live in `packages/contracts/src/{ownership,organizations,collaboration-grants,organization-billing,organization-matrix}.ts`, platform `organizations/`, `organization-matrix/`, extracted `database/`, `billing/` and `funded-ai/`, gateway `collaboration/` and `sync/`, shared UI `collaboration/` and `organizations/`, and the existing shell/Electron/mobile/CLI adapters. [tasks.md](tasks.md) assigns exact files, tests and composition owners. Reuse current services behind these seams; no additional running ACL service is proposed.

Documentation in this feature consists of `spec.md`, `research.md`, `data-model.md`, `contracts/organization-api.md`, `plan.md`, `tasks.md`, `sol-runbook.md` and `quickstart.md`. Implementation will add its own log and evidence; planning does not fabricate those test results.

## Delivery order for Sol agents

Each S-packet has exact checkboxes in [tasks.md](tasks.md), an owner, prerequisites and an independent exit test. A packet is a work assignment, not permission to create a giant PR. Structural extraction is split into mechanical layers before behavior; each layer meets the review limits. Use `gpt-5.6-sol` with high reasoning, at most three independent workers plus one coordinator. Do not dispatch implementation during this planning turn.

| Packet | Responsibility | Prerequisites | Agent lane |
| --- | --- | --- | --- |
| S00 | Provider/boundary probes and baseline gates | Planning review | Coordinator/Sol |
| S01 | Platform DB/VPS/billing/funded extraction | S00 | Platform |
| S02 | Gateway collaboration route/repository extraction | S00 | Resource |
| S03 | Shared owner/audience/proof/billing contracts | S00 | Contracts |
| S04 | Clerk lifecycle projection and fresh authority | S01,S03 | Platform |
| S05 | Org/group/guest command APIs | S04 | Platform |
| S06 | Grant evaluator and direct-grant migration | S02,S03 | Resource |
| S07 | Request/stream/queue revocation enforcement | S04,S05,S06 | Integration |
| S08 | Dynamic discovery and admin inventory | S07 | Platform |
| S09 | Org audience UI for existing session sharing | S08 | UI |
| S10 | File/folder catalog and shared reads | S07 | Resource |
| S11 | File/folder mutations and boundary moves | S10 | Resource |
| S12 | App instances and production project adapters | S11 | Resource |
| S13 | Service-only Matrix group communication | S05,S07, S00 Matrix gate | Matrix |
| S14 | Legacy sync grant migration | S11 | Sync |
| S15 | Shared sync gateway data plane | S14 | Sync |
| S16 | Shared sync daemon and CLI mounts | S15 | Sync |
| S17 | Typed org runtime ownership/routing | S05,S07 | Platform |
| S18 | Org provision/backup/recovery groundwork | S17 | Platform |
| S19 | Org Stripe accounts and admin billing | S17 | Billing |
| S20 | Explicit ownership transfer/export/lifecycle | S12,S18,S19 | Resource |
| S21 | Sponsored AI/credits and payer attribution | S19,S20 | Billing |
| S22 | Org admin, billing and app/file/group UI | S09,S12,S13,S19,S20,S21 | UI |
| S23 | Native Mobile/CLI parity | S16,S22 | Surfaces |
| S24 | Full acceptance, operational rollout and site docs | S00–S23 | Integration |

First usable milestone: S00–S09 supplies organization-aware sharing of existing eligible personal Chats/terminals (projects remain gated until S12), with the same owner/payer. Do not call it full delivery: standalone resources, independent org ownership/billing and Matrix groups have separate gates. Files/apps complete at S12; sync at S16; durable org ownership at S20; billing/AI at S21; all-surface feature acceptance at S24.

## Constitution check (before and after design)

| Gate | Design result |
| --- | --- |
| Owner-controlled data/personal boundary | Typed owner, explicit transfer and export/recovery; no admin access to unrelated personal content |
| Headless/multi-shell | One authority and contract layer; shared UI/adapters with separate surface evidence |
| Security/validation | [Exact auth matrix](contracts/organization-api.md), current evidence, deny fences, bounded IO and no Matrix bypass |
| Postgres/Kysely/atomicity | [Data model](data-model.md) defines transaction order, idempotency, outbox and inaccessible orphan states |
| TDD | Every implementation packet starts with failing behavioral tests; real Postgres for races/migrations |
| File size/review discipline | Mandatory mechanical extractions; manual worktrees and Graphite layers; current-head Greptile 5/5 then `ready-for-ci`; no merge inferred |
| Docs | Separate `FinnaAI/matrix-os-site/content/docs/` PR required at delivery |
| Provider verification | Explicit S00 probes; no unverified SDK guarantees accepted as design facts |

No constitutional waiver is proposed. Provider consistency, production price configuration and direct Matrix client support are explicit capability gates, not hidden assumptions. All implementation checkboxes remain open.

## Rollout and rollback

Additive migrations and personal backfills first; test old/new compatibility and restart at every checkpoint. Proposed capability flags are independent: org authority, principal grants, standalone resources, shared sync, org runtimes, org billing, managed Matrix groups. Default off; existing 121/525 capabilities keep their current configuration. Prefer separate runtime-version eligibility over a flag that old code could bypass.

For a migrated V2 scope, rollback disables access/new work or returns to the last V2-capable release; it never revives the V1 direct-member allow path. Do not drop legacy fields/tables until rollback retention and all consumers are verified. Pause billing admissions but still settle/refund already recorded charges. Drain streams before DB/pool shutdown. Reconcile fenced/staged transfers before reopening writes. Validate on a disposable VPS-native environment, scoped to reviewed handles; no fleet deploy is implied. Ask whether to delete the test VPS afterward. Remove completed worktrees only after merged-head/clean-tree/no-active-process checks.

### Billing/provisioning join

S18 builds typed provision/backup/recovery with injected test entitlements and a production-unavailable result until the real org entitlement adapter exists. S19 depends on S17 (typed identity), not paid provisioning. Its final integration with S18 enables provision only after a current org entitlement exists. S20 ownership transfer waits for both S18 and S19. No packet needs a paid org machine before billing can be implemented.
