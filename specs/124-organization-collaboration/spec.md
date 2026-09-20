# Organization collaboration

**Status:** Product draft with implementation plan for review — no runtime implementation authorized

**Date:** 2026-09-20

**Baseline:** Repository `origin/main` at `94985f02e`; source inspection, not a live deployment audit.

## What exists and what is missing

| Requested capability | Current evidence | Gap |
| --- | --- | --- |
| Share projects and individual Chats | [121 collaboration](../121-collaboration-session-sharing/spec.md); gateway collaboration authority, repository, actor proofs, resource adapters and shared UI exist | Grants address individual actors; no org/group audience resolution |
| Clerk organizations and membership | [058 gallery](../058-app-gallery/spec.md) defines gallery-owned org/member tables; collaboration schema permits `owner_type=organization` | No Clerk org lifecycle/membership integration in collaboration; an ownership field alone does not supply org authorization |
| Matrix groups | [077 messaging bridge](../077-matrix-messaging-bridge/spec.md), user provisioning and Matrix room client | Messaging rooms are separate from collaboration grants; no org/group mapping |
| Org admin billing | [084 billing](../084-stripe-runtime-plans/spec.md) excludes team billing; platform billing types key subscriptions to `clerkUserId`; [118](../118-ai-gateway-provider-auth/spec.md) defers org-shared provider billing | Org payer, admin billing controls and usage attribution missing |
| Admin view of shared resources | Per-scope membership/audit and per-user discovery exist | No org-wide resource/access inventory |
| Share one app | 121 shares project-owned apps/data; 058 covers app distribution and defers shared org instances | No standalone live app-instance collaboration scope |
| Share one file/folder | [066 sync](../066-file-sync/spec.md#4-sharing--collaboration) has share CRUD; its [F19 follow-up](../066-file-sync/follow-ups.md) records incomplete recipient data access | Separate permission model; data-plane routes still restrict callers to their own namespace; standalone files excluded from 121 |

[525 collaboration UX](../525-collaboration-ux-redesign/spec.md) improves ordinary-session sharing and discovery while preserving the existing authority. It does not close these gaps. Current collaboration scope kinds are `chat`, `terminal`, `project`, with an eight-participant limit. Implementation anchors: `packages/contracts/src/collaboration.ts`, `packages/gateway/src/collaboration/{authority,database,repository-shared}.ts`, `packages/platform/src/collaboration/`, `packages/platform/src/billing.ts`, and `packages/gateway/src/sync/routes.ts`.

## Minimum product

Every member can share resources they own with people, their entire organization, or an org group. Org admins manage membership, organization billing, and a searchable inventory of organization-owned resources and resources shared with the organization or its groups.

### 1. One identity and access model

- **Clerk is authoritative for organizations, invitations, memberships and org roles.** Reuse its organization management flows; local Postgres records are reconciled projections, not a separately editable membership directory. Map immutable Clerk user/org IDs to Matrix OS identities and Matrix IDs.
- **Matrix OS owns resource grants and org-group definitions in Postgres/Kysely.** Grant audiences are a user, organization, or org group; resource roles remain viewer/editor, with owner/admin management authority evaluated separately. Org groups contain current Clerk org members only. An org admin role is not automatically an editor grant on someone's personal resource.
- **Matrix Spaces/rooms represent organizations and groups for communication.** The planned first rollout uses service-only rooms and Matrix OS-mediated group text, authorized from Clerk plus org-group definitions. Human/AI user identities are not directly joined to these rooms; direct Matrix-client membership needs a separate proven revocation mechanism. Matrix room invitations, power levels or Space membership never independently grant file/app/Chat access or billing rights. Canonical AI Chat history stays in its existing store; no automatic transcript/file mirroring into rooms.
- Verified lifecycle events plus reconciliation update projections idempotently. Access requires sufficiently fresh membership evidence; stale/unavailable authority fails closed. Org removal invalidates org/group-derived access, pending work and live subscriptions within 60 seconds, including when a webhook is missed. After local revocation commits, new operations and delayed mutations are rejected immediately. The plan must prove this bound for Clerk checks, runtime proofs and Matrix room reconciliation, including outages; room delivery must be gated if it cannot enforce the bound. Already downloaded content cannot be recalled.

### 2. One Share experience

Share shows the resource boundary, owner, audience, viewer/editor role and effective access. Selecting an org grants its current and future members access without individual resource invitations; group sharing tracks current group membership. Individual invitations keep the existing acceptance flow. Ordinary members can share what they own; viewers/editors cannot reshare another owner's resource by default.

| Resource | Shared boundary |
| --- | --- |
| Project | All present/future project-owned contents, preserving 121's all-or-nothing inheritance |
| Chat | One conversation; no parent project, sibling Chats or external attachment destinations |
| App | One running app instance and its owned data; publishing/installing a copy remains a separate gallery action |
| File | One file; no parent/sibling access |
| Folder | Its current/future descendants; no parent, external links or symlink escapes |

Standalone sharing works inside a private project without sharing that project. Items already under a shared project inherit its grants and cannot acquire independent child exceptions. Folder grants likewise inherit downward; moves into/out of shared boundaries require an access-impact confirmation. Overlapping grants combine allowed actions after each grant’s role and any legacy action ceiling are applied; removing one grant leaves access from others, visibly explained. Removing org membership removes all access to org-owned resources; independent personal-resource invitations may remain and must be identified as such.

Sharing preserves ownership and payer. A separate explicit transfer can make a resource org-owned, with durable org storage/runtime authority that survives the creator leaving. Org admins control org-owned resources and their grants; content access still requires an explicit resource grant, including an audited self-grant if an admin needs it. Being an admin does not reveal members' unrelated personal data. Existing terminal sharing and immutable public Chat snapshots remain intact.

### 3. Organization administration and billing

- An org admin sees **Shared resources**: resource name/type, owner, sharing actor, audience, effective roles, external recipients, timestamps and audit history. Include org-owned resources and personally owned resources granted to that org/groups. Personal resources shared only with individuals are outside this inventory. Show synchronization/unavailable states truthfully.
- Admins can manage org-owned grants and remove grants into their org/groups. They cannot transfer, delete or broaden access to somebody else's personal resource. Inventory metadata does not confer content access.
- An org billing account uses the existing Stripe integration, keyed to the Clerk org ID rather than an admin's personal subscription. Authorized admins manage plan, payment method, invoices and runtime/AI usage; ordinary members cannot change billing. Membership or administrator changes never silently change the payer.
- Org-sponsored runtimes and AI execution name the org payer explicitly. Admin-approved budgets/entitlements govern new spend; actor, resource owner and payer are recorded separately. Sharing a personal resource does not start org charges or import personal provider credentials. No automatic fallback to a member's payment method. Failed payment follows an explicit org entitlement/grace policy while preserving export/recovery rights.

## Integration and acceptance

Extend the existing path: authenticated actor → platform membership resolution/proof → owner/org gateway collaboration authority → resource adapter → authorized realtime delivery. Reuse one grant evaluator for app actions, file downloads/uploads, sync, search and streams. Reconcile 066's separate grants into this authority before enabling shared-file access; do not run two competing permission systems. Org provisioning must provide owner-controlled Postgres and durable runtime routing independent of any member's personal VPS.

Test first, using an admin, two members and an outsider:

1. Share each of the five resource kinds with an org and a group; authorized members discover/open it, viewers cannot mutate, and outsiders cannot discover/read it. Whole-project and folder inheritance include future contents without leaking sibling resources.
2. Join/leave the org, change groups and roles, replay/out-of-order/drop membership events, then exercise stale links, direct APIs, queued AI, sync and live streams. Verify revocation bounds and honest remaining-access explanations.
3. Admin inventories show exactly their authorized scope. Removing a creator preserves org-owned resources; personal resources remain personal. Matrix membership changes alone cannot grant resource or billing access.
4. An admin manages org billing; a member cannot. Concurrent/retried spend is attributed once to the selected payer; exhausted budgets or payment failure cannot charge personal accounts.
5. Migrate legacy direct/sync grants without broadening access. Preserve snapshots, eight-person direct sharing, and project inheritance. Org audiences must not expand into or silently truncate to the existing eight-person member list; pagination and bounded concurrent participation are separate limits.

Validate Web Canvas, Web Desktop and Electron Desktop with shared schemas/components; include Web Mobile, Native Mobile and CLI wherever the capability exists. The [implementation plan](plan.md), [Sol task list](tasks.md) and [agent handoff](sol-runbook.md) now supply the planning artifacts. Before implementation, validate the exact endpoint/WebSocket/webhook auth matrix, group/resource-role mapping, transaction and outbox boundaries, membership freshness proof, migration/rollback plan, finite limits/timeouts and shutdown/cleanup ownership. No new endpoint contracts are introduced by this draft. Deliver a separate public documentation PR in `FinnaAI/matrix-os-site/content/docs/` alongside implementation/tests.

## Decisions proposed for review

1. “Matrix groups” means org teams backed by service-only private Matrix rooms within an org Space, accessed through Matrix OS in the first rollout. Arbitrary external/federated room membership is not a sharing audience in this first version.
2. “Share an app” means collaborate on the same instance/data; sending an installable copy remains the gallery flow.
3. Admin visibility covers org-related sharing, not all personal activity by employees. External guests require explicit grants to org-owned resources and cannot bypass org removal through an old member grant.
4. Org billing covers explicitly sponsored runtime and AI costs. Seat pricing, included quotas and existing personal-subscription migration need a separate commercial decision before billing implementation.

Approval extends 121's standalone-resource/billing exclusions, replaces 058's independent org membership ownership, and unifies 066 permissions. Detailed planning must reconcile those documents explicitly. Collaborative character editing, unrestricted federation, automatic ownership transfers and new pricing are outside this minimal draft.

**External references:** [Clerk Organizations](https://clerk.com/docs/guides/organizations/overview), [Clerk roles and permissions](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions), [Matrix Spaces specification](https://spec.matrix.org/latest/client-server-api/#spaces). These support the integration primitives; the authority split above is a proposed Matrix OS design.

## Story mapping for the implementation plan

US1 (P1): Clerk organizations/groups and lifecycle. US2 (P1): common organization-aware sharing. US3 (P1): standalone apps/files/folders and shared data access. US4 (P1): admin inventory, durable organization ownership and transfer. US5 (P1): organization billing and sponsored AI. US6 (P2): managed Matrix-backed group communication. P2 changes delivery order, not the full requested scope.
