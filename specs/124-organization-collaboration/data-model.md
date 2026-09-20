# Data model and authority

Use PostgreSQL/Kysely and existing migrations/repositories. Reuse equivalent tables discovered on rebase. No new database engine or independently running ACL service. Identifiers below are proposed schema names, frozen by S02 before parallel implementation.

## Identity and ownership

`ActorId` is immutable Clerk user ID. `OwnerRef` is personal or organization principal. `RuntimeRef` is an enrolled machine and authority generation; `AssignedMember` never substitutes for its owner. `PayerRef` resolves an independent billing account. `ResourceRef` identifies project/Chat/terminal/app/file/folder; paths and app slugs are not identities. `AccountRef` is a V3 harness/account/access-source binding plus credential owner and custody runtime. `AudienceRef` is actor/org/group. The platform does not store content paths, worktree patches, transcripts or integration results for routing.

## Platform control records

| Record | Fields / invariant |
| --- | --- |
| organizations/memberships | Clerk IDs, explicit role/permission mapping, lifecycle, monotonic membership epoch; upstream request-start/expiry; verified webhook inbox and reconciliation; webhook alone does not create fresh positive authority |
| groups/group_members/guests | Org-scoped IDs, generation, acceptance and expiry; groups contain current members; former members cannot revive access as guests without new admission |
| organization_commands/inbox/outbox | Idempotency key + payload hash, provider event ID, pending/confirmed/failed/unknown; metadata only; external requests outside DB transactions |
| runtime_endpoints | Runtime ID, registered exact HTTPS origin, asymmetric public keys/key IDs, owner, protocol version, authority generation, health/last heartbeat; no caller-supplied arbitrary target URL |
| resource_directory | Stable resource/scope ID, home runtime/generation, safe title/type, owner, audience discovery metadata and revision; index is never final authorization |
| collaboration_denials | Org/actor/resource generations, fence timestamp and affected runtime acknowledgement/lease deadline; unavailable acknowledgement cannot claim completed revocation |
| member_computer_assignments | Org, actor, machine, resource owner policy, sponsorship, lifecycle, recovery owner; one effective assignment role per machine; no pooled org runtime required |
| billing_accounts/sponsorships | Payer principal and Stripe customer, runtime/scope references, owner/payer consent, budget, revision and effective time; one effective hosting payer, no inferred owner-card fallback |
| invite_quotes/compute_commands | Server SKU, currency/estimated tax/proration, expiry, current and incremental recurring totals, quote digest, strategy, consenting payer; invitation/acceptance/entitlement/provision IDs with idempotency |
| organization_room_bindings | Private service-only Matrix room and org/group generation; unrelated to resource authority |

Computer control streams carry only generations, endpoint updates, membership assertions, metering and acknowledgements. Bound caches by count and expiry; outboxes retry with backoff and explicit dead-letter state.

## Home-computer records

| Record | Fields / invariant |
| --- | --- |
| collaboration_scopes | Stable resource ID, owner, home runtime/generation, parent scope, lifecycle, policy revision; one authoritative writer |
| collaboration_grants | Audience, preset, explicit actions/selectors, pending/active/revoked/expired, source ID, exact legacy ceiling, revision; org grants do not fan out to every member |
| capability_profiles/restrictions | Versioned action sets, file/folder/app/Chat selectors, denies, parent/org ceilings, approval requirements; parent restrictions cannot be widened below |
| resource_catalog/app_instances | Non-reused file/folder/instance IDs, path incarnation, parent and namespace, revision/tombstone; app namespace is owner-controlled and not a shared slug |
| collaboration_access_requests | Actor, scope, requested capability, proposed bounded operation, approver class, state/expiry/revision; approval never creates a generic owner session |
| direct_sessions/nonces | Actor/device key, resource, home generation, ticket nonce, expiry; bounded single-use handshake records and proof replay window |
| collaboration_run_bindings | Existing canonical run ID plus requesting actor, executing owner, one project-selected V3 binding, payer/policy, worktree/root fingerprint, executor, Chat audience ceiling, session generation; immutable once admitted |
| project_execution_policies | One active owner-selected V3 source, owner-only or eligible delegated submission mode, allowed harnesses/models, budget/concurrency, task profiles and integration grants; versioned owner approval |
| project_default_chat | Unique project ID to canonical Chat ID/root and audience binding; idempotent create/join, joining does not create a worktree or provider account |
| project_git_operations | Requestor, owner approver, tree/ref digest, approved remote/branch/action, one-use expiry, commit/PR result and unknown/reconciling state; owner Git identity and broker-held forge credential, immutable operation audit |
| worktree_leases | Worktree ID, Chat/run/terminal holders, fencing token, heartbeat/deadline and root fingerprint; one writer, bounded readers |
| filtered_workspace_operations | Source revision, allowed catalog set, materialization digest, produced-file audience label, staged patch, publication state; no unrestricted Git object store |
| integration_connections/delegations | V3-style credential owner/custody runtime, encrypted local secret reference, allowed actors/scopes/tools/upstream resources, revisions and approval rules; no plaintext in ordinary owner data exports |
| transfers | Exact inventory/version digest, source/target runtime and owner, dual consent, authority generation, phase, checksums/checkpoint/recovery state |
| resource audit/outbox | Actor/action/resource/generation/result, no secrets/transcript; transactional with authority changes |

Keep canonical Chat/project/worktree entities; extend them rather than adding another Chat store. Per-person drafts/read state stay private. Existing direct-member/sync records are imported once then removed from the authorization read path, not maintained as dual authorities.

## Evaluation and publication

1. Resolve current lifecycle, runtime generation and actor identity.
2. Resolve fresh membership/guest/group evidence for org-derived grants.
3. Union matching explicit allows, intersect parent/resource/org hard ceilings and original migration action ceilings, subtract matching denies. No implicit management/funding privilege from editor or org admin.
4. For a run, intersect actor capabilities with Chat audience data ceiling, the single project owner source and its submission mode, payer budget, task profile and sandbox capabilities. For commit/merge/push/PR also require a current exact owner Git approval, regardless of generic integration/task grants. For integration calls also intersect upstream OAuth/resource scope.
5. Reauthorize queue claim, each tool/terminal input, output publication, final upload/patch commit and stream batches. Previously started remote effects cannot be recalled; no next step gets expired authority.
6. Artifacts inherit the data audience of their inputs. A broader publish/merge is a separately approved declassification operation; general merge permission is insufficient. Mixed-sensitivity historical Chats cannot be broad-shared without explicit review.

## Lease and revocation protocol

Connection tickets expire within 30 seconds and bind the client's ephemeral proof key, actor, resource, exact endpoint audience, home generation, purpose, nonce and permitted maximum actions. They are exchanged once on the home endpoint, never a generic gateway login. Identity session maximum is five minutes with explicit reauthentication; org authorization remains separately limited by a 20-second evidence deadline anchored to the upstream request start. A long identity session cannot extend an org grant.

Homes consume signed platform org/group/denial epochs over one authenticated control stream and check local resource policy on every operation. Coalesce membership refresh for active actors (target ten seconds), not for every file chunk or keystroke. On disconnect, evidence expires at its original deadline and operations stop; positive caches never refresh themselves. Watchdogs run at most five seconds apart, check before every output/input batch, and terminate isolated processes that lose required authority. Enforce deadline before admitted writes/side effects and use final revision/epoch conditional writes. Long staging confers no right to publish.

A platform revocation is pending until affected runtime fences acknowledge or old leases expire. Home-local removal rejects new operations immediately after its transaction. Target org-provider removal bound is 60 seconds including missed webhooks; S00 must demonstrate supported Clerk freshness under concurrent changes/outage. No unverified hard external-provider SLA is claimed. Clock skew tolerance never extends a deadline. Offline homes must synchronize current generations before accepting connections again.

## Transactions and recovery

Home lock order: scope root, affected catalog roots in stable ID order, grants/policy, operation/run, resource write. Platform lock order: org, member/group/assignment, command/fence, audit/outbox. Use CAS in UPDATE or row locks, ON CONFLICT idempotency and payload-hash checking. Multi-write operations commit together. No provider/network call while holding database locks and no cross-computer transaction assumed.

Transfers: prepared → staging → fenced → committing → active, with blocked/recovering errors. Both endpoints authenticate, validate inventory and reject path/symlink/hardlink escapes. Source stays sole authority until it durably fences writes. Target verifies all required bytes/DB exports before the platform directory CAS moves the generation. Old host remains fenced; target waits for the committed generation before accepting writes. Lost acknowledgement is resolved from directory generation and journal, not retrying a second activation. Keep a restricted backup with owner/recovery policy; credentials, personal identity/memory and private drafts excluded. Active provider processes are stopped; unsupported provider session migration starts a fresh authorized continuation. Dirty worktrees are inventoried, never discarded.

Admission quote/entitlement/provision use durable command state and idempotent Stripe requests; payment and provisioning happen outside DB transactions. Capture original payer at reservation and settle/refund against it even if sponsorship later changes. Do not rewrite personal Stripe customer IDs to simulate a transfer. Adoption of an existing subscription requires supported payer migration or separately approved cancellation/new billing; uncertain outcome blocks a duplicate charge.

## Cutover

Back up and freeze collaboration writes; drain runs/streams; inventory all IDs, grant ceilings and assigned homes. Stage idempotent shadow import and validate counts/digests/authorization. Upgrade all applicable clients/homes and signing keys, CAS direct protocol activation, then remove legacy content proxy/readers from serving. Unsupported old clients receive upgrade-required, never a fallback session. Temporary migration readers/backups are not runtime compatibility. Rollback keeps compatible direct authorization or disables collaboration pending recovery. Ordinary personal billing remains intact.

## Single-source first release

Store one project funding selection and immutable per-run copies. Existing V3 owner accounts remain available to the owner’s settings; participant account enrollment/stores/selection and round-robin routing are not added. Shared project sessions never inherit private provider history. Group membership, discussion permission and AI submission permission are separate. Copy-and-continue is future independent project creation, not a transfer state or V1 peer operation. It will receive new resource/grant/account identities and exact revision provenance.
