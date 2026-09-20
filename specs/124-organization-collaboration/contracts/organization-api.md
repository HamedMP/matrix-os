# Organization collaboration contracts

Proposed additive contracts. S03 owns shared schema changes; subsequent packets consume them. Existing exact route allowlists remain restrictive. No public resource or billing access is introduced.

## Common wire rules

Use strict Zod 4 objects. All mutations carry UUID `clientRequestId`, decimal-string `expectedRevision` where a record exists, and a discriminated action schema. Same key/different payload returns conflict; retries return the same accepted operation. UUIDs identify scopes/groups/files/operations, Clerk IDs use bounded provider-specific schemas, paths use bounded relative segments and resolveWithinHome plus symlink-safe checks. No caller-selected owner directory, database schema, R2 prefix, price amount or payer identity is trusted.

Responses expose safe data and capability flags, bounded error codes (`invalid_request`, `unauthorized`, `not_found`, `forbidden`, `conflict`, `capacity`, `unavailable`) and optional operation IDs. Unauthorized resource existence is hidden. Never return provider errors or Zod internals. POST/PUT/PATCH/DELETE use Hono bodyLimit before reading bytes; session-authenticated mutations validate Origin/CSRF, CORS is an explicit allowlist. Webhook signatures are the exception to session/Origin auth, not to body limits.

## Auth matrix

`U` = existing verified Clerk/app/native/CLI user identity resolving to immutable actor ID; `O` = freshly verified org membership; `A` = mapped current org admin permission; `G` = current resource grant/capability at owner gateway; `R` = registered-runtime service auth; `P2` = platform-signed request-bound actor/owner/audience evidence. Session-selected org/header is only a selector and cannot satisfy O/A.

| Method + route | Service | Required authorization | Purpose/public? |
| --- | --- | --- | --- |
| GET `/api/organizations` | Platform | U | Actor's organizations only; no |
| POST `/api/organizations` | Platform | U + Clerk create permission | Idempotent Clerk-backed create; no |
| GET `/api/organizations/:orgId` | Platform | U+O | Safe org status/capabilities; no |
| PATCH `/api/organizations/:orgId` | Platform | U+O+A | Rename/settings via Clerk command; no |
| DELETE `/api/organizations/:orgId` | Platform | U+O+A + typed confirmation | Fence deletion then Clerk command/recovery; no |
| GET `/api/organizations/:orgId/members` | Platform | U+O | Paginated safe member directory; no |
| POST `/api/organizations/:orgId/invitations` | Platform | U+O+A | Clerk invitation; no |
| DELETE `/api/organizations/:orgId/invitations/:invitationId` | Platform | U+O+A | Cancel Clerk invitation; no |
| PATCH/DELETE `/api/organizations/:orgId/members/:actorId` | Platform | U+O+A; self-leave separate typed action | Map role/remove with pre-fence, last-admin guard; no |
| POST `/api/organizations/:orgId/leave` | Platform | U+O; actor only | Fence self-leave; no |
| GET/POST `/api/organizations/:orgId/groups` | Platform | GET U+O; POST U+O+A | List/create groups; no |
| PATCH/DELETE `/api/organizations/:orgId/groups/:groupId` | Platform | U+O+A | Rename/delete; no |
| GET/PUT/DELETE `/api/organizations/:orgId/groups/:groupId/members/:actorId` | Platform | GET U+O; writes U+O+A | Exact membership; actor must be current org member; no |
| GET/POST `/api/organizations/:orgId/groups/:groupId/messages` | Platform→Matrix service room | U+O + current group membership (admin alone cannot read an unjoined group) | Text-only bounded history/send; no |
| GET `/api/organizations/:orgId/groups/:groupId/events` (WS upgrade) | Platform | One-use ticket + U+O + current group membership, renewed per batch | Managed-room text delivery; no |
| POST `/api/organizations/:orgId/guests` | Platform | U+O+A | Explicit guest invitation; no |
| POST `/api/organizations/:orgId/guests/:guestId/accept` | Platform | U matches invited guest | Accept guest admission; no |
| DELETE `/api/organizations/:orgId/guests/:guestId` | Platform | U+O+A | Revoke all guest access to this org; no |
| POST `/webhooks/clerk/organizations` | Platform | Verified Clerk webhook signature, timestamp/replay checks on raw bounded body | Public ingress, authenticated by signature |
| POST `/internal/organizations/access/resolve` | Platform | R + original platform-signed actor request and validated runtime/scope/audience binding | Bounded fresh assertions for relevant org/group IDs; no |
| GET `/api/organizations/:orgId/shared-resources` | Platform | U+O+A | Paginated inventory; no |
| DELETE `/api/organizations/:orgId/shared-resources/:scopeId/grants/:grantId` | Platform→gateway | U+O+A; grant addressed to this org/group | Inbound denial fence + idempotent owner removal; no |
| GET `/api/organizations/:orgId/audit` | Platform | U+O+A | Bounded content-free admin audit; no |
| GET `/api/organizations/:orgId/operations/:operationId` | Platform | U+O+A or exact initiating actor with retained recovery permission | Async outcome; no |
| GET/POST `/api/organizations/:orgId/runtimes` | Platform | U+O for permitted reads; U+O+A + entitlement for create | Org-owned runtime discovery/provision; no |
| GET `/api/organizations/:orgId/billing` | Platform | U+O+A billing capability | Status/invoices/usage; no |
| POST `/api/organizations/:orgId/billing/checkout` | Platform | U+O+A billing capability | Server catalog SKU only; no |
| POST `/api/organizations/:orgId/billing/portal` | Platform | U+O+A billing capability | Server-selected org Stripe customer/return URL; no |
| PUT/DELETE `/api/organizations/:orgId/sponsorships/:scopeId` | Platform | U+O+A + verifiable resource-owner consent | Budget/payer approval/revoke; no |
| GET/POST `/api/collaboration/scopes/:scopeId/grants` | Platform→gateway | U + P2 + G read/manage respectively | Principal grants; no |
| PATCH/DELETE `/api/collaboration/scopes/:scopeId/grants/:grantId` | Platform→gateway | U + P2 + G manage | Revision-checked grant changes; no |
| GET `/api/collaboration/scopes/:scopeId/access` | Platform→gateway | U + P2 + G read | Actor's effective permissions/reasons only; no |
| GET `/api/collaboration/scopes/:scopeId/files` | Platform→gateway | U + P2 + G read | Scope-filtered paginated catalog; no |
| GET `/api/collaboration/scopes/:scopeId/files/:fileId/content` | Platform→gateway | U + P2 + G read, renewed while streaming | Mediated download, safe headers/ranges; no |
| POST `/api/collaboration/scopes/:scopeId/files/actions` | Platform→gateway | U + P2 + G per action | create/upload-init/commit/rename/delete/move-preview/move-confirm; no |
| GET `/api/collaboration/scopes/:scopeId/apps/:appId` | Platform→gateway | U + P2 + G read | App instance metadata/eligibility; no |
| POST `/api/collaboration/scopes/:scopeId/apps/:appId/view` | Platform→gateway | U + P2 + G read | Scoped app bootstrap; no owner session/token; no |
| GET `/api/collaboration/scopes/:scopeId/apps/:appId/assets/*` | Platform→gateway | U + P2 + G read or exact short-lived view capability rechecked against G | Validated artifact asset only; no |
| POST `/api/collaboration/scopes/:scopeId/apps/:appId/actions` | Platform→gateway | U + P2 + G per app action | Validated actor-aware app bridge; no |
| POST `/api/collaboration/scopes/:scopeId/transfers` | Platform→gateway | U + P2 + G transfer + target org admin consent | preview/confirm typed transfer; no |
| GET `/api/collaboration/shared` (extend) | Platform | U then fresh audience resolution/hydration | Personal/org/group discovery; no |
| Existing scope preflight/create, invitation accept/decline, Chat/discussion/AI, terminal, project/lifecycle/export routes | Platform→gateway | Existing auth + P2/G for V2 scope; current actor/owner checks generalized | Preserve exact routes, add kinds through typed adapters; no |
| Existing `/api/sync/manifest`, `/presign`, `/commit`, multipart and conflict routes (extend) | Gateway | Existing personal auth unchanged; shared mode requires scope proof+G for every operation | Namespace server-resolved, exact file/folder filters; no |
| Existing collaboration events/terminal WS and shared sync event WS | Platform→gateway | One-use ticket; U + P2 + G at connect, replay, every frame/batch and renewal | No org/user query parameter as authority; no |
| Existing Stripe webhook | Platform | Existing verified Stripe signature/event dedupe | Add payer-account mapping; public ingress with signature auth |

Invitations to the Clerk organization are accepted through Clerk's supported flow, not a resource-grant endpoint. Native clients may open the hosted Clerk flow and then refresh authoritative state. Org admin role changes use an allowlisted mapping (`org:admin`→admin, `org:member`→member, configured creator role→owner); unknown roles deny until explicitly configured. Group management has no independent Matrix role override.

## Proof V2 and runtime checks

Retain method/path/query/body/conditional-header digest, runtime/scope, nonce and key rotation binding. Add OwnerRef, actor membership/group/guest generations, evidence checkedAt/expiry, relevant audience IDs and denial-fence version. Verification requires `expiresAt <= min(issuedAt+30s, membershipEvidenceDeadline)`; an old cache cannot create a fresh lease. Every org authorization calls the platform resolver for current local revocations; positive upstream evidence may be reused only before its fixed deadline. No stale-positive fallback on timeout. V1 is accepted only for explicitly unmigrated personal/direct scopes.

Streams renew evidence separately from their handshake, reauthorize before each send/input/replay batch, and close within a 5-second watchdog of an expired/denied permission. Queued AI reauthorizes at dispatch and before broker tool effects; terminals lose control leases on removal. Org resources require eligible scoped execution, never an admin's personal provider session. Cohort policy must evaluate actual actors/org enablement, not test whether an org ID is a user in the old cohort array.

## Limits and lifecycle

Initial caps: page 100; search 200 characters; JSON 96 KiB (webhook 256 KiB); 100 org/group grants per scope; preserve seven invited direct users per personal scope. Org directory pages do not count as invitations. Use existing connection limits (256/gateway, 32/scope, four/actor/scope) until load-tested changes are explicit. Cap active authority lookup keys at 10,000 with expired-first/LRU eviction; coalesce concurrent lookups per identity. Org/group/guest directories must paginate and reject unsupported requested batch sizes, never silently truncate an audience.

Upstream API timeout 10 seconds; authorization lookup timeout five seconds; membership evidence lifetime 20 seconds from request start; refresh target 10 seconds; stream watchdog five seconds; max allowed clock skew five seconds, without extending evidence validity. Combined bounds must be measured, not summed into an untested 60-second claim. General outbox retry uses jittered 1s→60s backoff and at most 20 attempts before alert/dead-letter; revocation correctness cannot depend on retry completion. Inbox metadata retained 30 days; dedupe tombstones at least 90 days; staging uploads/transfers expire after 24 hours unless attached to an active recovery operation. Recurring cleanup uses lstat, skips symlinks and drains on shutdown.

Shared downloads renew during transmission and stop on revocation; previously delivered bytes are not retractable. Shared upload URLs, if used, write only non-visible staging keys, never authoritative keys; commit validates current scope/role/generation and cleans rejected objects. Do not grant reusable R2 GET URLs for shared content. Reuse current configured file size limits and resumable upload protocols; add bounded streaming rather than buffering whole files.

## Managed Matrix room boundary

V1 rooms admit the service identity only; users interact through the two group routes above. User-authored events carry server-derived actor attribution; clients cannot choose the sender. Service tokens stay in platform secret storage. Private rooms are non-federated with joined-only history and service-only invitation/state powers. Serve text only; no generic Matrix proxy, arbitrary room ID, raw `mxc` URL, end-user room invite, direct Matrix deep link or resource-content mirroring. Group members see retained group history under the current group grant; removal denies subsequent retrieval even if they previously viewed it. Already delivered text remains outside recall. Existing unrelated Matrix messaging is unchanged.

## App view boundary

The view response binds an instance, actor, allowed actions, resource scope and generation to the existing sandboxed app renderer. Assets resolve only inside the approved artifact; validate wildcard segments before filesystem use. Use the existing isolated-origin/CSP policy with an exact gateway origin and narrowly scoped view capability; never give the iframe owner cookies or a generic app-slug bridge token. Recheck current grants on assets/actions; viewer controls cannot mutate by bypassing the UI. Dynamic app state stays in the instance namespace. If the current renderer cannot support these constraints, standalone activation is unavailable until S12 supplies the adapter.

## Required project routes not yet mounted in the gateway

The platform proxy already allowlists these; S12 must implement their gateway registrations and real dependencies. All use U+P2+G, are non-public and apply current project inheritance. Mutating forms use the common idempotency/revision/body-limit rules.

| Method + path (prefix `/api/collaboration/scopes/:scopeId`) | Validation / capability |
| --- | --- |
| GET `/project/files` | Bounded normalized relative path/query, read/list only within catalog bindings |
| PUT `/project/files` | Typed write/staged-commit payload, expected catalog revision; edit capability |
| DELETE `/project/files` | Validated relative target and conditional headers; delete-content capability, never project root |
| GET `/project/git` | Bounded allowlisted status/diff query; read, no arbitrary shell command |
| POST `/project/git/actions` | Discriminated allowed Git actions with bounded ref/path/message fields; edit plus scoped execution policy |
| GET `/project/apps/:appId` | Resolved instance binding; read |
| POST `/project/apps/:appId/actions` | Per-action app schema; actor-aware instance bridge capability |
| GET/PATCH `/project/layout` | Read / revision-checked bounded node action union; edit |
| POST `/project/chats` | Validated title/config; edit/create child with inherited grants atomically |
| POST `/project/terminals` | Validated bounded launch profile; edit plus eligible isolated runtime, no owner shell |

Exports continue through the existing lifecycle/operation/export routes; S12 supplies their real drivers. The full concrete payload schemas reuse/refine `specs/121-collaboration-session-sharing/contracts/collaboration-api.md`; S03 freezes their allowlisted discriminants and rejects arbitrary command/record casts.

## Additional privileged and permit operations

| Method + path | Authorization / purpose |
| --- | --- |
| POST `/api/organizations/:orgId/runtimes/:runtimeId/admin-access` | U+O+A runtime-admin capability, exact org owner binding; audited short-lived capability with explicit route allowlist. Ordinary members cannot use generic owner shell, files, bridge or terminal creation |
| POST `/api/collaboration/scopes/:scopeId/sponsorship-consents` | U+P2+G owner/manage plus explicit owner confirmation; produces signed single-use scope/payer/policy consent receipt |
| POST `/internal/organizations/access/permits/:permitId/complete` | R plus matching original platform actor proof and registered permit/runtime/request; idempotent completion acknowledgement, never caller-selected foreign permit |

`access/resolve` issues the recorded request-bound permit; revocation fences prevent issuance and completion waits for outstanding permits as defined in data-model.md. Read-only evidence may be cached to its fixed expiry; mutation publication must obtain a current permit, recheck local grant epochs and complete within the bounded lease. Inert long-running staging does not retain publication authority. No provider lookup executes while holding an owner DB transaction.
