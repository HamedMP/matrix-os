# Research and decisions

**Baseline:** fetched `origin/main` on 2026-09-20: `94985f02eeb2c39ad337b144778db35d0b66c393`. The spec branch contains only documentation. Findings are source inspections, not assertions about production enablement. All unimplemented file names in the plan/tasks are proposed additions.

## R1 — Keep Clerk membership and resource grants separate

**Decision:** Clerk owns org identity, invitations, membership and role assignment. Platform holds a reconciled projection plus bounded freshness evidence; owner/org databases hold resource grants. Matrix room membership is a projection, never an application permission.

**Evidence:** `packages/gateway/src/collaboration/authority.ts` authorizes through `repository.getMember(membershipScope.id, actorId)`; `packages/contracts/src/collaboration.ts` admits only Chat/terminal/project scopes and direct/inherited membership. `packages/gateway/src/collaboration/database.ts` already permits an organization owner type, but that is not a Clerk integration. `packages/platform/src/collaboration/proof.ts` signs actor/runtime/scope-bound 30-second proofs.

**Alternatives rejected:** replacing resource ACLs with Clerk roles (cannot express individual resource boundaries); expanding org membership into thousands of direct invitations (stale, capacity-limited and changes acceptance semantics); Matrix room membership as a second grant authority.

## R2 — Freshness deadlines must not add together

**Decision:** Org membership evidence expires 20 seconds after the start of a successful authoritative Clerk lookup. A cached entry, signed proof, runtime permit or stream refresh can never extend that original deadline. Refresh active identities after 10 seconds where capacity permits; deny at expiration if refresh fails. A dropped webhook therefore does not extend access indefinitely. Negative/revocation events immediately mark local evidence unusable; replayed positive events require a fresh lookup before access resumes.

**Rationale:** [Clerk documents webhook synchronization as eventually consistent](https://clerk.com/docs/guides/development/webhooks/syncing). Webhooks provide invalidation, not a hard timing guarantee. Rechecking only at WebSocket connect is insufficient. The 60-second target is a release acceptance requirement, not a claim about Clerk's consistency SLA.

**Gate:** S00 must test lookup deletion/role behavior and budget the 60 seconds, including clock skew, in-flight operations and watchdogs. If Clerk can return stale positive membership without a bounded authoritative check, the strict guarantee for changes made outside Matrix cannot be claimed. Keep org sharing disabled until the product requirement or verification mechanism is explicitly resolved. Matrix-originated removal fences access before calling Clerk and remains locally denied across ambiguous failures.

## R3 — Organization ownership is a runtime change

**Decision:** Carry `{type: personal|organization, id}` separately from actor and payer. Provision a durable org-owned VPS/storage authority. Personal resources shared to an org remain on their personal owner runtime; explicit transfer stages data into an org authority and changes routing only at a fenced commit point.

**Evidence:** `packages/gateway/src/collaboration/chat-execution-adapter.ts` has a personal-only `ownerFor`; collaboration policy currently treats `scope.owner_id` as a cohort user. Existing funded policy/metering compares `machine.clerk_user_id` with the runtime owner. Simply storing an org ID in user columns is unsafe.

**Alternatives rejected:** assigning ownership to the current admin; sharing their personal VPS/token with members; silently moving resources or switching the payer when an org audience is added.

## R4 — One evaluator, exact legacy semantics

**Decision:** Introduce principal grants for users/orgs/groups at the existing collaboration authority. Direct-user acceptance stays explicit. Organization/group grants are dynamic. Project inheritance remains singular; shared folders inherit into descendants. Cross-boundary moves use an inventory revision and explicit preview/commit, with no child exceptions in an already shared project/folder.

**Evidence:** `packages/gateway/src/sync/routes.ts` keeps grantee data access fail-closed. `sync/sharing.ts` implements viewer=get, editor=get/put, admin=get/put/delete; it does not implement admin reshare powers. Do not import the more permissive prose in 066 as existing behavior.

**Migration decision:** import accepted/pending/expired grants with immutable identity mappings, source IDs and exact action ceilings. Legacy sync admin becomes an editor grant with a delete-content ceiling, never owner or org-admin. Normal new file editors may write/create/rename/delete contents but cannot delete the share root or change access. Legacy editor remains unable to delete until its owner explicitly upgrades it. Ambiguous handles, overlapping incompatible boundaries or unsupported resources enter a blocked report and stay inaccessible; never infer broader grants.

## R5 — Share live instances, not installable copies

**Decision:** App sharing covers one instance and its data; reuse the project app adapter's actor-aware sandbox/bridge restrictions. File/folder sharing adds dedicated adapters, including mediated shared downloads, uploads and sync commits. References to resources outside the selected boundary remain inaccessible. App publishing and snapshot links stay independent.

**Rationale:** Existing project file/app adapters are currently test-referenced rather than mounted through production collaboration routes. Connecting them is required work. They are reusable seams, not proof that an arbitrary app is safe for standalone collaboration. Unsupported app capabilities block activation, with a specific eligibility result. Direct R2 download capabilities cannot provide immediate revocation once issued; shared reads use an authorizing gateway stream. Uploads may stage inert objects, but only a fresh authorized commit makes them visible.

## R6 — Matrix groups require a separate enforcement gate

**Decision:** First rollout uses one managed org Space and one private room per org group, joined only by a service identity. Members read/send group text through authenticated Matrix OS routes with the same fresh group authority. Never invite human/AI user identities into these rooms or expose service tokens, direct room URLs or media URLs. Org groups remain platform records constrained to Clerk members. Do not mirror canonical AI transcripts, resource content or billing information. This explicitly refines the minimal draft’s membership-projection wording; native Matrix client participation is a later gated capability.

**Rationale:** [Matrix Spaces](https://spec.matrix.org/latest/client-server-api/#spaces) organize rooms; their parent/child state is separate from room membership. A Space removal is not a recursive resource revocation mechanism. Async kick jobs cannot alone enforce an outage-time deadline for clients that can reach the homeserver directly.

**Gate:** S00/S13 must prove ordinary human/AI tokens cannot join or read these service-only rooms through direct `/sync`, history or state endpoints, and cannot send/invite. Use invite-only rooms, `m.federate:false`, `history_visibility:joined`, service-only power levels, and text-only content (no raw Matrix media capabilities). Matrix OS expires both read and send authority, including during a platform-to-homeserver partition. If any bypass exists, group communication remains disabled; org-group resource sharing may still ship. Direct Matrix clients require a separately reviewed server-side enforcement mechanism; asynchronous kicks are insufficient.

## R7 — Extend Stripe billing without inventing a price

**Decision:** Introduce typed personal/org payer accounts and explicit runtime sponsorship. Preserve current personal subscriptions. Org checkout selects operator-configured existing catalog entries; absent approved org prices/quotas, checkout is unavailable. Build and test with Stripe test fixtures. No seat pricing, automatic subscription consolidation or personal-card fallback is inferred.

**Evidence:** `packages/platform/src/billing.ts` models `StripeSubscriptionProjection.clerkUserId`; `ai-funded-policy-repository.ts` and `ai-funded-metering-repository.ts` bind paid runtime identity to a personal machine owner. Sharing permission is not funding authorization.

## R8 — Reuse current UI and split large composition files first

**Decision:** Extend 525's normal session access controls and Shared with me; add organization settings/admin inventory, plus app/file/folder Share entrypoints. Keep presentation adapters thin across Web Canvas, Web Desktop, Electron Desktop, applicable mobile and CLI.

**Evidence:** At the baseline, platform `db.ts` is 5,316 lines, billing routes 1,650, gateway collaboration routes 1,059; contracts/repository/database are also large. Mandatory extraction packets precede behavior in these files. Keep new focused files below 500 lines and each PR ideally below 1,000 additions/20 files, with a hard split before 3,000/50.

## Planning scope

The user's follow-up authorizes this detailed plan, not implementation, deployment, billing activation or publishing. The optional Spec Kit before/after commit hooks are not needed for research; documentation is committed explicitly after validation. Product assumptions from the minimal draft remain visible in `spec.md`; S00 validates provider behavior instead of allowing later agents to guess it.
