# Deployment and execution contracts

**Status:** proposed interfaces/routes for [plan.md](../plan.md). None is claimed implemented by this document. Existing routes retain contracts unless a dedicated compatibility task changes them. Validate with Zod 4 and bounded schemas before service calls.

## Deployment capabilities

`DeploymentProfileV1` declares installation/mode/connectivity/edition, revision, registered adapters, required capabilities, trust/credential/authority references and installation-owned policy. `DeploymentCapabilitiesV1` projects only version/revision, actor-allowed operations, safe availability and setup actions. States: available, disabled-by-policy, unsupported, setup-required, temporarily-unavailable.

No raw provider error, internal hostname, secret path, private customer data or unverified proof appears in the client projection. Entitlement is a separate optional availability input; it cannot set principal/role/ownership/egress policy.

Startup invariants: hosted defaults exist only in hosted mode; air-gap has no implicit Matrix/Clerk/R2 origin fallback; every required capability has a registered bounded implementation; optional absent modules produce declared state; shared packages never import `ee/`. Configuration changes are revisioned and controlled; revocation fences admitted work.

## Trust hierarchy

1. **Installation operator:** owns global destination/CA/egress/capability ceilings, trust roots, runtime enrollment and recovery policy. High-privilege operator enrollment is separate from ordinary organization administration.
2. **Organization administrator:** may assign only a subset of that ceiling within the exact organization. Cannot add a new trust root/destination, grant another org access or elevate itself to installation operator.
3. **Member/app/model:** may request only granted operations. Prompt text, model tool calls, app manifests and client headers cannot widen authorization or network scope.

Enforce hierarchy in owning services with exact installation/org/actor scope, revision checks and audit records, not merely UI hiding. Regression cases include cross-org grant IDs, stale revisions, org admin attempting global CA/address mutation and model-generated policy edits.

## Execution backend

Proposed `packages/contracts/src/execution-backend.ts`; owning gateway modules under `packages/gateway/src/execution/`.

| Request group | Required authority |
|---|---|
| Actor/owner | Verified immutable internal actor and personal/org owner, membership epoch, server-derived purpose. |
| Identity | Existing canonical Chat/turn/run or background job, idempotency key and payload digest. |
| Model | Exact endpoint/model/artifact/protocol/capability and policy/grant/trust revisions; no implicit provider/account/payer fallback. |
| Scope | Canonical workspace/root identity, read/write/tool/action/app/data grants and bounded approved internal services. |
| Limits/control | Finite queue/start/headers/idle/total deadlines, token/byte/context/attachment/tool/concurrency/disk limits, cancellation generation, approval/input channel and checkpoint version. |

Operations: describe capabilities, admit, start, cancel; optional resume/recover/steer/submit approval/input. Reuse canonical Chat events. Recover observes/reconciles the exact run, never starts a new prompt. Advertise only enforced capabilities and record each backend's restart/process-loss/resume/cancel matrix, including unsupported cases.

Current generic Pi/OpenCode adapters stay read-only. Write-capable execution needs qualified OS confinement or brokered tools; cwd is insufficient. Agent children receive no gateway/DB/admin secrets or unrestricted LAN access. Model-returned tools are untrusted requests to existing action/approval authority. App AI remains text-only/no owner tools/files. Bot tools require separate broker authorization. Background work binds its own route/purpose and cannot borrow a changed interactive provider. Historical SDK helpers must migrate or fail unavailable before effects.

## Internal inference transport

An internal endpoint is operator-enrolled, distinct from a user-provided URL. Registry records exact normalized scheme/origin/port/path family, model/capability inventory, trust roots, credential kind/reference and revision. Org grants are subsets, not new enrollment.

- Authorize at connection time and pin accepted destination/service identity while preserving TLS hostname checks. DNS preflight alone does not stop rebinding.
- Reject redirects by default; any required hop passes the same destination/credential authority. Never forward credentials to a different authority.
- Keep metadata/link-local/multicast/unspecified targets forbidden. Loopback only for fixed Matrix-owned adapter or separately scoped operator enrollment; no blanket localhost allowance.
- Support installed customer CAs and scoped mTLS/bearer if selected. Never disable TLS verification for qualification.
- Explicit `none` credentials/readiness for keyless endpoints; do not fabricate a cloud account. Secrets stay with trusted gateway transport.
- Bound requests/streams and malformed SSE/JSON/tool frames; unexpected model identity is rejected. Health returns coarse readiness only.

Ordinary user URL tools retain private/internal SSRF controls. Host/process/network enforcement also covers Python/native SDKs, shell/build children, MCP, browsers and DNS; patching `fetch` is insufficient.

## Identity, ownership, discovery and collaboration

Shared core verifies sessions/OIDC/JWKS and maps `(installation, exact issuer, subject)` to immutable internal actor; internal org IDs are separate immutable identities. Verify exact issuer/audience/algorithm/key/time/replay state. Never identify owner by email/raw subject, and never fall back to configured owner in multiuser mode. Explicit account linking/migration requires verified source/destination ownership and audit; restore cannot reassign data by email match.

Internal membership authority provides role/state/epoch/freshness and drives transactional revocation outbox. Reuse collaboration proofs/role semantics. Runtime enrollment binds owner/runtime/generation/key and operator-approved origin; service tokens alone cannot choose a human actor. Internal direct origins use enrolled-runtime policy while hosted public-origin restrictions remain.

Native/Electron use scoped sessions/device flow with internal origins/trust roots, never administrator bearer. Browser WS needs explicitly allowlisted short-lived audience/path/scope-bound query tokens or reviewed cookie auth. Authenticate and authorize before subscription success; sweep stale/dead senders, evict on send failures and drain on revocation/shutdown. Unreachable authority cannot extend privileged membership freshness.

## Route and local-operation auth matrix

Names marked proposed are additions, not existing endpoints. Reconcile final naming with owning routers and preserve compatibility tests. Initial lifecycle uses privileged local CLI/files rather than a new remote binary-upload API.

| Surface | Auth and authorization | Payload/resource policy |
|---|---|---|
| Proposed `GET /api/deployment/capabilities` | Verified runtime actor; owner/org-filtered safe capability projection. | Bounded known list; no remote health sweep or credential acquisition during discovery. |
| Proposed `GET /api/admin/inference-endpoints` | Installation operator; org administrator receives only grants it may administer, never global mutation rights. | Bounded pagination, secret-free records, policy-scoped topology. |
| Proposed `POST /api/admin/inference-endpoints` | Installation operator only; scoped admin credential or same-origin session with CSRF defense. | Hono `bodyLimit` before parsing, proposed 32 KiB JSON cap; strict origin/model/trust-reference schema, bounded validation work. |
| Proposed `PATCH /api/admin/inference-endpoints/:id` | Installation operator, installation scope and exact base revision. | `bodyLimit` 32 KiB, validated path ID and action union; 409 on stale version; revocation fences affected bindings. |
| Proposed `DELETE /api/admin/inference-endpoints/:id` | Installation operator; audited disable/revoke and scope check. | `bodyLimit` 4 KiB even if ignored; validated ID/revision; repeat delete does not refresh tombstone. |
| Proposed `/api/admin/organizations/:orgId/inference-grants` GET/POST/PATCH/DELETE | Verified installation operator or exact-org admin; service verifies subset of global ceiling and target org. | Per-method strict schemas; mutating `bodyLimit` 32 KiB, DELETE 4 KiB; request/revision identity, no CA/address mutation fields. |
| Existing Chat/App AI/Bot families | Existing actor, owner/org, scope/tool/app grant and exact route admission. Local backend is not auth bypass. | Retain current body/attachment/rate/queue/idempotency; validate local capability/model binding. |
| Existing session/collaboration/discovery families | Internal verification/membership/runtime-proof adapters; hosted retains existing providers. | Preserve bounded schemas/anti-replay; internal origin acceptance is enrolled-runtime policy only. |
| Proposed optional `GET /api/enterprise/admin/status` | Verified enterprise admin plus separate licensed feature decision. | Coarse local readiness; no secret/license payload/error echo. |
| Proposed optional `POST /api/enterprise/admin/entitlements` | Installation operator; CSRF defense/scoped admin credential; installation-bound signed payload. | `bodyLimit` 64 KiB strict envelope; local verification; cannot change identity/roles/egress. |
| Optional directory webhook/reconcile | Approved internal issuer/service, signature/audience/freshness and idempotency. | Explicit provider-specific `bodyLimit`, bounded discriminated event union; correct retryable 4xx/5xx behavior. |
| Local verify/import/update/restore CLI | Customer host operator or narrowly privileged service; local ownership and exclusive host-operation lock. | Verified bounded file/stream in staging root, signatures/digests/path/platform/schema checks before execution; no shell interpolation. |

Every new mutating HTTP endpoint, including DELETE, webhook and device approval, requires `bodyLimit` before buffering, path/query/body validation, explicit rate/resource bounds, timeout and generic error mapper. A later network artifact import API needs separate streamed quota/authorization design; offline bundles do not justify unbounded uploads.

## Errors, transactions and retries

Public error allowlist: unauthorized/forbidden/invalid request/conflict/capability unavailable/operation unavailable/operation failed; HTTP 401/403/400/409/503/500 as appropriate. Internal configuration failure is 5xx/unavailable, not not-found. Detailed provider/DB/filesystem causes stay in protected logs with sanitized correlation IDs; clients cap/allowlist display strings.

Stable request ID + payload hash makes retries idempotent; same ID/different payload conflicts. Uncertain tool/external effect cannot auto-replay. Related admission/grant/membership/audit-outbox writes transact together, with revision check in SQL or authoritative row lock. Publish realtime revision/time after commit and isolate/evict failed subscribers. Endpoint/membership/key/entitlement revisions have separate authorities: none refreshes or substitutes for another.

## Artifact and lifecycle contract

`OfflineReleaseManifestV1` binds source/build/profile/platform, supported schema window, all sizes/hashes, executable/dependency/model inventory, SBOM/source/notices and signatures. Trust root is provisioned independently. Verify every archive path/type/payload before extraction or any code/hook/migration/model custom-code execution; reject traversal/symlink escapes/duplicate entries, corrupt/missing bytes, untrusted keys, wrong architecture and unsupported downgrade.

Reuse shared staging, host lock/journal, updater rollback/repair and protected-owner-data policy. UI and daemon consume the same source/polling configuration. Quiesce work, maintain schema compatibility, journal transitions and reconcile interruptions without replaying uncertain migrations. App rollback cannot imply DB downgrade. Backup restore verifies source/ownership and is tested on a separate clean host. Failure never reconnects silently to Matrix Cloud.

## Entitlement independence

Selected direction: AGPL core plus public commercial/source-available EE, with rights/combination review before adopting terms. Local entitlement uses separate signing roots and no call-home. Invalid/expired grant affects only defined commercial administration behavior; it cannot create roles, widen egress, weaken security, delete data or block core login/export/backup/restore. Safe migration/restore cannot depend on an abruptly expiring seat check. Document offline time/revocation limitations and key recovery.

## Qualification

Exercise real model/backend/HTTP/WS/Postgres/broker/native child/importer/client boundaries. Required missing prerequisites fail, not skip. Same source revision qualifies hosted, physically absent-EE and enterprise modes. Negative tests cover wrong/foreign issuer same-subject, email reuse, restored ownership, org-admin ceiling escalation, keyless readiness, endpoint/grant revocation, malformed model stream/tools, DNS/redirect changes, interruption/low disk, uncertain writes and credential leakage. Sensitive validation traces remain in private security artifacts.
