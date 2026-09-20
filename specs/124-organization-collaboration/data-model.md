# Data model and authority

Use PostgreSQL/Kysely and existing migrations/repositories. Reuse equivalent tables discovered on rebase. No new database engine or independently running ACL service. Identifiers below are proposed schema names, frozen by S02 before parallel implementation.

## Identity and ownership

`ActorId` is immutable Clerk user ID. `OwnerRef` is personal or organization principal. `RuntimeRef` is an enrolled machine and authority generation; `AssignedMember` never substitutes for its owner. `PayerRef` resolves an independent billing account. `ResourceRef` identifies project/Chat/terminal/app/file/folder; paths and app slugs are not identities. `AccountRef` is a V3 harness/account/access-source binding plus credential owner and custody runtime. `AudienceRef` is org or an actor who is a current member of the resource's organization; every scope records its organization and no audience resolves outside it. The platform does not store content paths, worktree patches, transcripts or integration results for routing.

## Platform control records

| Record | Fields / invariant |
| --- | --- |
| organizations/memberships | Clerk IDs, default roles, AI submission enablement projected from Clerk organization public metadata (absent means owner-only), lifecycle, monotonic membership epoch; upstream request-start/expiry; verified webhook inbox and reconciliation; webhook alone does not create fresh positive authority |
| groups/group_members/guests (deferred from V1) | Org-scoped IDs, generation, acceptance and expiry; groups contain current members; former members cannot revive access as guests without new admission |
| organization_commands/inbox/outbox | Idempotency key + payload hash, provider event ID, pending/confirmed/failed/unknown; metadata only; external requests outside DB transactions |
| runtime_endpoints | Runtime ID, relay-routable home address from existing customer-VPS enrollment, optional future direct origin, asymmetric public keys/key IDs, owner, protocol version, authority generation, health/last heartbeat; no caller-supplied arbitrary target URL |
| resource_directory | Stable resource/scope ID, home runtime/generation, safe title/type, owner, audience discovery metadata and revision; index is never final authorization |
| collaboration_denials | Org/actor/resource generations, fence timestamp and affected runtime acknowledgement/lease deadline; unavailable acknowledgement cannot claim completed revocation |
| member_computer_assignments | Org, actor, machine, resource owner policy, sponsorship, lifecycle, recovery owner; one effective assignment role per machine; no pooled org runtime required |
| billing_accounts/sponsorships | Payer principal and Stripe customer, runtime/scope references, owner/payer consent, budget, revision and effective time; one effective hosting payer, no inferred owner-card fallback |
| invite_quotes/compute_commands | Server SKU, currency/estimated tax/proration, expiry, current and incremental recurring totals, quote digest, strategy, consenting payer; invitation/acceptance/entitlement/provision IDs with idempotency |
| organization_room_bindings | Private service-only Matrix room and org/group generation; unrelated to resource authority |

V1 platform records are organizations/memberships, the organization command inbox for verified webhooks, runtime_endpoints, resource_directory and collaboration_denials. Groups/guests, member_computer_assignments, billing_accounts/sponsorships, invite_quotes/compute_commands and organization_room_bindings are deferred from V1 and retained above for the administration release. Computer control streams carry only generations, endpoint updates, membership assertions, metering and acknowledgements. Bound caches by count and expiry; outboxes retry with backoff and explicit dead-letter state.

## Home-computer records

| Record | Fields / invariant |
| --- | --- |
| collaboration_scopes | Stable resource ID, owner, owning organization, home runtime/generation, parent scope, lifecycle, policy revision; one authoritative writer |
| collaboration_grants | Audience, deriving organization, preset, explicit actions/selectors, pending/active/revoked/expired, source ID, exact legacy ceiling, revision; an organization-wide grant is one row with audience `organization`; it never fans out into per-member grant rows. Pending is the absence of a `collaboration_grant_activations` row for (grant, actor): `Shared with me` derives a member's pending items as organization grants of their current organization minus their activation rows of either state, so a member who joins later sees the item pending with no row written on their behalf and a decline settles it durably. Opening the share is the accept: the accept request performs one atomic transition by `INSERT ... ON CONFLICT (grant_id, actor_id) DO NOTHING` into the activation table inside the same transaction that re-checks fresh membership, so a concurrent second accept is idempotent and a member without an activation row is not a participant; no grant outlives the membership it derives from |
| collaboration_grant_activations | Grant ID, actor ID, state `active` or `declined`, decided_at, membership evidence epoch at decision, unique on (grant_id, actor_id); exists only for organization-wide grants; no row is pending, an `active` row is participation, a `declined` row durably suppresses the item from `Shared with me` and grants nothing; accept is `INSERT ... ON CONFLICT (grant_id, actor_id) DO UPDATE SET state = 'active' WHERE collaboration_grant_activations.state = 'declined'` (idempotent when already active), decline is the same statement with the states swapped and is refused once active (leaving is a separate lifecycle action); rows are deleted with the grant, and departure ends them with the membership they derive from |
| capability_profiles/restrictions (deferred from V1) | Versioned action sets, file/folder/app/Chat selectors, denies, parent/org ceilings, approval requirements; V1 stores one whole-project preset per grant |
| resource_catalog/app_instances | Non-reused file/folder/instance IDs, path incarnation, parent and namespace, revision/tombstone; app namespace is owner-controlled and not a shared slug |
| collaboration_access_requests (deferred from V1) | Actor, scope, requested capability, proposed bounded operation, approver class, state/expiry/revision |
| direct_sessions/nonces | Actor/device key, resource, home generation, ticket nonce, expiry; bounded single-use handshake records and proof replay window |
| collaboration_run_bindings | Existing canonical run ID plus requesting actor, executing owner, one project-selected V3 binding, payer/policy, worktree/root fingerprint, executor, Chat audience ceiling, session generation; immutable once admitted; it carries no status. Run status lives only on the referenced canonical Chat run/request record, which gains the `interrupted` status set when the home loses the run; re-admission of preserved queued requests after the home returns writes a new binding only when the requester's membership evidence is fresh |
| project_execution_policies | One row per execution scope: a project scope or a standalone Chat scope (a Chat shared inside a project has no row of its own and uses the project's). One active owner-selected V3 source, submit mode (follow organization, or owner-only), owner provider-terms acknowledgement, allowed harnesses/models, budget/concurrency; versioned owner approval of the policy itself. The scope owner (the member who owns and hosts the resource) is the only actor who may set it, and for a standalone Chat that owner takes every role the spec gives the project owner: source selection, submit-mode restriction, privileged cancel and tool-approval (task profiles and integration grants deferred) |
| project_default_chat | Unique project ID to canonical Chat ID/root and audience binding; idempotent create/join; joining creates no worktree, copy or provider account; share-time inventory of every Chat root in the project |
| project_git_operations | Requesting member, run, operation (commit/push/PR), remote/branch, result and unknown/reconciling state; owner Git identity and broker-held forge credential; no owner approval in V1; immutable operation audit |
| worktree_leases (deferred from V1) | Worktree ID, Chat/run/terminal holders, fencing token, heartbeat/deadline and root fingerprint |
| filtered_workspace_operations (deferred from V1) | Source revision, allowed catalog set, materialization digest, staged patch, publication state |
| integration_connections/delegations (deferred from V1) | Credential owner/custody runtime, allowed actors/scopes/tools/upstream resources; V1 shared runs use the owner's existing connections |
| transfers | Exact inventory/version digest, source/target runtime and owner, dual consent, authority generation, phase, checksums/checkpoint/recovery state |
| resource audit/outbox | Actor/action/resource/generation/result, no secrets/transcript; transactional with authority changes |

Keep canonical Chat/project/worktree entities; extend them rather than adding another Chat store. Per-person drafts/read state stay private. Existing direct-member/sync records are inventoried and dispositioned (terminate with notice, or the owner re-homes them into an organization) rather than imported as personal grants; none remain on the authorization read path. The platform `collaboration_rollout_policy` table and its milestone/mode/cohort contract are dropped without replacement.

## Evaluation and publication

1. Resolve current lifecycle, runtime generation and actor identity.
2. Resolve fresh membership evidence for every grant; a resource without a resolvable organization context, or an actor without current membership in it, denies before any allow is considered. No environment flag or cohort record participates.
3. Union matching explicit allows, intersect parent/resource/org hard ceilings and original migration action ceilings, subtract matching denies. No implicit management/funding privilege from editor or org admin.
4. For a run, intersect actor capabilities with Chat audience data ceiling, the single project owner source and its submission mode, payer budget, task profile and sandbox capabilities. Commit/push/PR run through the Git broker under the owner identity with no approval in V1. Integration calls use the owner's existing connections.
5. Reauthorize queue claim, each tool/terminal input, output publication, final upload/patch commit and stream batches. Previously started remote effects cannot be recalled; no next step gets expired authority.
Deferred from V1 with granular sharing: 6. Artifacts inherit the data audience of their inputs. A broader publish/merge is a separately approved declassification operation; general merge permission is insufficient. Mixed-sensitivity historical Chats cannot be broad-shared without explicit review.

## Lease and revocation protocol

Connection tickets expire within 30 seconds and bind the client's ephemeral proof key, actor, resource, logical runtime ID (never a TLS hostname), home generation, purpose, nonce and permitted maximum actions. They are exchanged once on the home endpoint, never a generic gateway login. Identity session maximum is five minutes with explicit reauthentication; org authorization remains separately limited by a 20-second evidence deadline anchored to the upstream request start. A long identity session cannot extend an org grant.

Homes consume signed platform org/denial epochs over one authenticated control stream and check local resource policy on every operation. Coalesce membership refresh for active actors (target ten seconds), not for every file chunk or keystroke. On disconnect, evidence expires at its original deadline and operations stop; positive caches never refresh themselves. Watchdogs run at most five seconds apart, check before every output/input batch, and terminate isolated processes that lose required authority. Enforce deadline before admitted writes/side effects and use final revision/epoch conditional writes. Long staging confers no right to publish.

A platform revocation is pending until affected runtime fences acknowledge or old leases expire. Home-local removal rejects new operations immediately after its transaction. Target org-provider removal bound is 60 seconds including missed webhooks; S00 must demonstrate supported Clerk freshness under concurrent changes/outage. No unverified hard external-provider SLA is claimed. Clock skew tolerance never extends a deadline. Offline homes must synchronize current generations before accepting connections again.

## Transactions and recovery

Home lock order: scope root, affected catalog roots in stable ID order, grants/policy, operation/run, resource write. Platform lock order: org, member/group/assignment, command/fence, audit/outbox. Use CAS in UPDATE or row locks, ON CONFLICT idempotency and payload-hash checking. Multi-write operations commit together. No provider/network call while holding database locks and no cross-computer transaction assumed.

Transfers (deferred from V1): prepared → staging → fenced → committing → active, with blocked/recovering errors. Both endpoints authenticate, validate inventory and reject path/symlink/hardlink escapes. Source stays sole authority until it durably fences writes. Target verifies all required bytes/DB exports before the platform directory CAS moves the generation. Old host remains fenced; target waits for the committed generation before accepting writes. Lost acknowledgement is resolved from directory generation and journal, not retrying a second activation. Keep a restricted backup with owner/recovery policy; credentials, personal identity/memory and private drafts excluded. Active provider processes are stopped; unsupported provider session migration starts a fresh authorized continuation. Dirty worktrees are inventoried, never discarded.

Admission quote/entitlement/provision (deferred from V1) use durable command state and idempotent Stripe requests; payment and provisioning happen outside DB transactions. Capture original payer at reservation and settle/refund against it even if sponsorship later changes. Do not rewrite personal Stripe customer IDs to simulate a transfer. Adoption of an existing subscription requires supported payer migration or separately approved cancellation/new billing; uncertain outcome blocks a duplicate charge.

## Cutover

Back up and freeze collaboration writes; drain runs/streams; inventory all IDs, grant ceilings and assigned homes. Stage idempotent shadow import and validate counts/digests/authorization. Upgrade all applicable clients/homes and signing keys, CAS direct protocol activation, then remove per-request authorization, policy readers and V1 fallback from the proxy, leaving the transparent relay. Unsupported old clients receive upgrade-required, never a fallback session. Temporary migration readers/backups are not runtime compatibility. Rollback keeps compatible direct authorization or disables collaboration pending recovery. Ordinary personal billing remains intact.

## Single-source first release

Store one project funding selection and immutable per-run copies. Existing V3 owner accounts remain available to the owner’s settings; participant account enrollment/stores/selection and round-robin routing are not added. Shared project sessions never inherit private provider history. Group membership, discussion permission and AI submission permission are separate. Copy-and-continue is future independent project creation, not a transfer state or V1 peer operation. It will receive new resource/grant/account identities and exact revision provenance.
