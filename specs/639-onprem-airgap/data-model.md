# Data model and durable ownership

**Status:** proposed design for [plan.md](plan.md), baseline `231eff01cf`. No schema migration is applied. Extend existing records through their owning modules; logical names below are not permission to create duplicate persistence.

## Sources of truth

| Scope | Canonical state | Ownership |
|---|---|---|
| Personal | Existing Chat/tasks/apps/files and local AI configuration | Owner Postgres/files; do not copy content into EE control-plane records. |
| Organization | Shared data and membership-bound policy | Organization-owned Postgres with explicit immutable org ID; departure removes access without merging personal data. |
| Installation | Profile, trust roots, global destination/CA ceiling, runtime enrollment | Customer operator-owned configuration plus local control-plane Postgres for durable coordination. |
| Artifact | Signed inventory, source/build/digests/schema compatibility | Immutable content-addressed staging/release storage; independent signer trust. |
| Entitlement | Signed commercial feature/term/installation limits | Separate optional record; never identity, role, data ownership or egress authority. |

Derived projections record authority and freshness. A prior Clerk projection cannot become internal membership authority by relabeling it. Relevant existing boundaries: `packages/platform/src/organizations/database.ts:4-8`, `packages/gateway/src/request-principal.ts:113-166` and canonical Chat records in `packages/gateway/src/chat/database.ts`.

## Deployment profile

**Proposed schema:** `packages/contracts/src/deployment-profile.ts`; loader `packages/gateway/src/deployment/profile.ts`.

- `schemaVersion`, stable nonsecret `installationId`, monotonic `revision`, created/updated timestamps and sanitized operator audit reference.
- Independent `mode` hosted/standalone, `connectivity` connected/air-gapped and `edition` community/enterprise. No combined paid/offline boolean.
- Registered identity/membership/runtime-discovery/artifact/backup adapter IDs and scoped configuration references.
- Bounded known capability records with implementation ID, enabled/disabled state, measured capability metadata and prerequisite references.
- Global network policy/trust-bundle revision plus opaque secret references; plaintext credentials are excluded from client projections.

Use an inspectable operator-owned file, restrictive permissions and atomic temp/write/rename. Protect it from agent/app writes. Validate cross-field dependencies at startup. Offline mode rejects implicit hosted defaults; optional capabilities expose deliberate unavailable state. Revisioned changes require compare-and-swap and controlled reload/revocation. Public projection exposes only safe capability state, not internal topology or credential locations.

## Endpoint trust and delegated grants

**Proposed owner:** `packages/gateway/src/inference-endpoints/`. Enrollment is installation policy, not app/model-writable data.

| Record/fields | Meaning |
|---|---|
| Endpoint identity | Installation-scoped endpoint ID/revision, lifecycle active/disabled/revoked; exact normalized origin/port and allowed API path/protocol families. |
| Destination ceiling | Installation operator's approved service/address policy, trust roots, maximum capabilities/budgets and allowed credential kinds. Metadata/link-local/multicast/unspecified destinations stay forbidden; loopback is separately scoped. |
| Org grant | `(installationId, orgId, endpointId)` plus revision, allowed models/actions and stricter optional limits. Must be a subset of current installation ceiling. Org admin cannot change global CA/address policy or grant another org access. |
| Trust/credential | CA key/version reference, hostname checks, optional mTLS client identity or bearer reference; explicit credential kind `none` for keyless service. No fictional authenticated cloud account. |
| Model inventory | Bounded approved model IDs/artifact hashes and measured context/output/tool/vision/protocol capabilities; readiness observation with checked-at/stale-after. |
| Resource policy | Finite connection/headers/idle/total deadlines, queues, concurrency, response/context/attachment/tool/token caps, quota and shutdown owner. |
| Audit | Operator/org-admin identity and policy revisions for create/change/grant/revoke/denial; sanitized cause/correlation ID without prompt, secret or raw upstream error. |

Endpoint ID is not a credential. Admission binds endpoint/model/grant revisions; use-time checks revalidate revocation before forwarding and cancel/drain when required. Address validation occurs at connection time and is pinned to the approved service identity; preflight DNS alone is insufficient. User-supplied web URLs cannot enroll or inherit the endpoint exception.

## Execution binding and durable runs

**Proposed contract:** `packages/contracts/src/execution-backend.ts`. Reuse existing Chat/Bot/task repositories rather than an EE run/transcript DB.

`ExecutionBinding` contains immutable internal actor/owner/org scope, admitted membership epoch, server-derived purpose, canonical run/turn/chat or background identity, request idempotency key/payload digest, backend/version, endpoint/model/grant/trust revisions, workspace/root identity, tool grants, deadline and cancellation generation. No credential values persist in it.

Map local backend events to existing canonical output/tool/approval/input/state/completion schemas (`chat/provider-adapter.ts:128-205`). Lifecycle: admitted → starting → running/waiting → completed, failed, aborted or recovery-required. Recovery reconciles the exact execution and cannot resubmit a prompt automatically. Tool effects track their own idempotency/effect certainty; a transport failure does not prove a write was absent.

Admission/run/task/audit-outbox related writes commit in one transaction. Enforce revision/generation in mutating SQL or lock the authoritative row. Logical singleton request IDs use unique constraints and `ON CONFLICT` with payload comparison. After commit, notify subscribers with new revision/time. Revocation fences future tools/subscriptions, not only UI projection.

## Internal identity and organization authority

**Shared verification/mapping:** `packages/gateway/src/identity/{provider,principal-mapper}.ts`. **Optional EE lifecycle administration:** `ee/identity/`, following the selected commercial direction and legal clearance.

| Logical record | Keys and invariants |
|---|---|
| Issuer configuration | Installation-scoped issuer ID, exact issuer URL/audience/algorithm/key-set reference, positive revision, active/revoked state. |
| Subject mapping | Unique `(installationId, exactIssuerId, subject)` → immutable internal actor ID. Emails/display names never identify owners; foreign issuers with same subject never collide. |
| Organization mapping | Immutable internal org ID plus installation/authority mapping. External org names/slugs/email domains are metadata, not reassignment authority. |
| Session/device request | Hash opaque secrets, bind actor/client/installation/audience/scopes and expiry/revocation epoch; single-use device approval generation, PKCE/state/nonce where applicable. |
| Membership | Existing org/actor role/state plus authority ID, membership epoch, authoritative event version, verified-at/stale-after. |
| Runtime enrollment | Existing owner/runtime/generation/protocol/key identity plus operator-approved internal direct origin and control-channel freshness. |
| Revocation outbox | Epoch-bound intent, target runtime, lease/attempts/dead-letter/acknowledged generation; membership change and outbox intent commit together. |

Adapt existing organization/collaboration storage through internal authority interfaces; do not build a second role model. New control-plane persistence uses customer Postgres/Kysely with versioned schema-lock migrations. Duplicate/reordered directory events compare authority version inside the transaction. Unreachable authority cannot locally extend privileged membership freshness. Revocation drains/fences unauthorized active work before acknowledging completion.

Single-owner-to-org migration is an explicit operator-approved ownership operation. Map exact source/destination immutable IDs, enumerate affected data/credentials/grants, verify ownership, capture recovery point and journal effects. Restore must retain approved mappings or require deliberate reconciliation; never reassign owner content by matching email or falling through to a configured shared owner. Multiuser mode disables configured-owner/dev-default identity fallback.

## Offline release and import

**Proposed schema:** `packages/contracts/src/offline-release.ts`; extend existing updater/journal.

`OfflineReleaseManifest` binds format/release/source/build identity, edition/profile, supported OS/CPU, minimum installer/updater, schema compatibility window, complete relative-path/file-type/hash/size inventory, runtime/package/model/tokenizer assets, SBOM/source/notices and signature envelope. Prohibit traversal, duplicate/case-colliding entries and symlink escapes; archive headers cannot choose destination paths outside verified inventory.

`ImportedReleaseReceipt` records manifest digest, signer/key version, independently provisioned trust-policy revision, verified content digests, operator/time and compatibility result. It contains no signing private key and cannot authorize activation on its own. Validate current operator selection/trust/compatibility again before update.

Keep `/opt/matrix/release.json` as installed provenance, separate from update subscription. Extend host transactions with manifest identity, expected prior/new versions, stage/reserve/verify/activate/migrate/health/commit phase and recovery metadata. One host operation lock plus crash-safe journal prevents concurrent update/import/restore corruption. An ambiguous migration is reconciled, not blindly replayed.

Rollback is allowed only when the prior application supports the current DB schema. Prefer expand/contract compatibility; otherwise enter maintenance/verified restore. Do not promise automatic destructive down-migrations. Bound staging space and retain rollback artifacts until their dependency expires. Protected owner home paths remain protected across install/update/rollback.

## Backup and restore

Backup manifest binds backup ID, installation/owner/org scopes, consistent capture generation/time, app/schema versions, encrypted DB/file/config/asset digests, required identity/key metadata, encryption key reference, destination and retention class. Keys stay under customer custody with a separately tested recovery procedure.

Restore records destination identity, source digest, dry-run compatibility, exclusive lease and progress journal; quiesce DB/files/services before activation. Preserve immutable ownership or explicitly reconcile it. Do not restore another owner's secrets through a path override. A backup cannot expire while it is the required recovery point for an active update/restore. Second-host restoration establishes actual recovery evidence and measured RPO/RTO.

## Offline entitlement

Selected direction is AGPL core plus public commercial/source-available EE; legal rights/combination review precedes terms/adoption. Proposed optional implementation: `ee/license/offline-entitlement.ts`.

Store a bounded locally signed document: licensor/key ID, installation/org binding, optional features/seat limits, validity/grace and version. Verification uses installed public keys, independent from release/identity/gateway keys. No online activation, telemetry or renewal callback. Define time skew/rollback, imported revocation/key rollover and recovery limitations honestly.

Invalid/expired entitlement affects only defined commercial administration behavior. It cannot create admin roles, broaden endpoints, corrupt data, disable security or block core login/export/backup/restore. A seat check cannot interrupt a data migration without a specified safe completion/recovery path.

## Migration, concurrency and cleanup

- Related DB writes use a transaction; optimistic checks belong in `UPDATE ... WHERE revision = baseRevision` or row locking. Idempotent creates use unique indexes/upserts.
- DB/files/object-store effects use durable journals/outboxes and content-addressed staging. Define acceptable orphan states and recurring ownership-aware reconciliation; a DB transaction cannot make object storage atomic.
- Files use exclusive temp creation, restrictive permissions, symlink-safe checks and atomic rename; use appropriate fsync for crash durability. No request-handler synchronous writes.
- Versioned migrations are locked, retry-safe and tested from each supported predecessor. Expand/contract precedes destructive cleanup. An absent EE tree cannot require EE schema to boot core.
- Caches/registries/subscriptions have caps, eviction/TTL, stale-connection sweeps and shutdown drains. Only resource owners close pools; scoped wrappers do not destroy shared dependencies.
- Device/upgrade tickets, credential handles, observations, import staging and orphan artifacts have bounded retention and recurring cleanup. Keep replay-rejection tombstones where necessary; ordinary/export reads exclude deleted records unless an explicit audit/recovery path needs them.
- Backup/model/package staging has quotas, low-disk preflight and safe refusal. Customer-approved retention values must be documented/tested; no unbounded default.

Validation covers issuer collision/email reuse/foreign-subject restore, concurrent grants and policy changes, same-ID/different-payload retries, midstream revocation, stale enrollment, full disk, interruption at every journal phase, corrupt backup and unsupported downgrade. Exercise actual Postgres/files/object staging/broker boundaries. Sensitive traces or confirmed vulnerability reproductions stay outside public planning files.
