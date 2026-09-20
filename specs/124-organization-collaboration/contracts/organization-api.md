# Direct collaboration contracts and auth matrix

S02 freezes strict Zod 4 contracts and package exports before dependent packets. This replaces the previous platform-forwarded resource API design. Every endpoint below is private unless explicitly called signed public ingress. The platform relay forwards resource routes as opaque bytes: it makes no allow/deny decision, parses no body or frame, logs no payload and enforces coarse byte/connection limits only. The home is the sole authorization point for every route below.

## Wire rules

Mutations require UUID clientRequestId, record expectedRevision where applicable, and a bounded discriminated payload. Same idempotency key/different payload conflicts. Validate all identifiers/path/query/body at boundary; no arbitrary target URL, owner filesystem path, payer or DB namespace. Resolve paths by catalog identity with symlink/hardlink escape checks. POST/PUT/PATCH/DELETE apply bodyLimit before buffering. Conditional DELETE uses validated headers where existing clients need bodyless DELETE. Generic errors only; hidden resource existence returns not-found. Cookies require exact Origin/CSRF; direct proof-authenticated requests also validate allowed client origin and proof binding. No wildcard CORS. No environment flag, milestone or rollout cohort gates any route: the actor's current membership in the resource's organization is checked on every collaboration route, WebSocket upgrade, queue claim, tool invocation and integration action, and missing signing/origin configuration fails closed.

`U`: verified Clerk/app/native/CLI actor; `O`: fresh Clerk org role/permission projection; `R`: enrolled runtime asymmetric identity; `T`: one-use platform-signed connection/operation ticket plus client proof of possession; `G`: local current grant/policy, always derived from the scope's organization; `F`: exact approved funding/credential delegation; `P`: authenticated peer runtime plus T naming actor, operation and both endpoints. Selected org, custom headers or network reachability are never authority.

## Platform control endpoints

V1 platform endpoints are `GET /api/organizations`, `GET /api/organizations/:orgId/members`, the `/api/collaboration/*` discovery and connection routes, the `/internal/*` runtime, control and access routes, and `POST /webhooks/clerk/organizations`. Every other row in this table is deferred from V1 and retained for the administration release; organizations and members are managed in the Clerk dashboard.

| Method + path | Auth | Behavior |
| --- | --- | --- |
| GET/POST `/api/organizations` | U; create permission for POST | Clerk-backed org discovery/create |
| GET/PATCH/DELETE `/api/organizations/:orgId` | U+O; profile/manage/delete permission for mutations | Idempotent Clerk commands; deletion fence and last-owner guard |
| GET `/api/organizations/:orgId/members` | U+O member-read | Paginated membership |
| POST `/api/organizations/:orgId/invitations/quote` | U+O members-manage; billing-manage for paid choices | No charge; server catalog and existing-computer eligibility |
| POST `/api/organizations/:orgId/invitations` | U+O members-manage + valid payer consent if paid | Quote ID/digest and compute choice; Clerk invitation |
| DELETE `/api/organizations/:orgId/invitations/:id` | U+O members-manage | Cancel pending command/invite without charge |
| PATCH/DELETE `/api/organizations/:orgId/members/:actorId`; POST `/leave` | U+O members-manage; leave actor only | Pre-fence, reconcile Clerk result, no silent last-owner removal |
| GET/POST `/api/organizations/:orgId/groups`; PATCH/DELETE `/:groupId`; PUT/DELETE `/:groupId/members/:actorId` | U+O; groups-manage for writes | Explicit current-member subsets |
| POST `/api/organizations/:orgId/guests`; POST `/guests/:id/accept`; DELETE `/guests/:id` | U+O members-manage; accept only invited U | Explicit admission/expiry, no former-member bypass |
| GET `/api/organizations/:orgId/shared-resources`; GET `/audit` | U+O resources-manage / audit-read | Metadata only, paginated |
| DELETE `/api/organizations/:orgId/shared-resources/:scopeId/grants/:grantId` | U+O resources-manage + inbound audience binding | Control denial + signed command to home, no content forwarding |
| GET `/api/organizations/:orgId/member-computers` | U+O plus assignment-read policy | Visible assignments, no org-wide computer |
| POST `/api/organizations/:orgId/member-computer-commands` | U+O billing-manage and assignment-manage policy | Discriminated sponsor/provision-member/reassign/end; quote/consent/entitlement checked |
| GET `/api/organizations/:orgId/billing`; POST `/billing/checkout`; POST `/billing/portal` | U+O billing-read/manage | Org customer only, server SKUs/return URLs |
| PUT/DELETE `/api/organizations/:orgId/sponsorships/:scopeId` | U+O billing-manage + resource-owner signed consent | Payer/budget policy, no personal fallback |
| GET `/api/collaboration/shared`; GET `/api/collaboration/inbox` | U+O as needed | Safe resource routing/discovery metadata, including organization-wide shares still pending for this member; client hydrates direct |
| POST `/api/collaboration/connections` | U+O as needed | Exact resource/purpose/client public key; directory-resolved endpoint and T, no content |
| POST `/api/collaboration/peer-operations` | U+G consent receipts + R as applicable | Transfer/tool/policy-sync tickets, exact source/target/action/digest; no arbitrary command |
| POST `/internal/collaboration/runtime-endpoints` | R plus enrollment bootstrap verification | Register relay-routable home address from existing customer-VPS enrollment, protocol/key generation and optional future direct origin; SSRF-safe validation |
| GET `/internal/collaboration/control` (WS) | R with one-use upgrade ticket | Signed epochs/assertions, no customer payload; reconnect snapshot before accepting work |
| POST `/internal/organizations/access/resolve` | R + actor-bound T/session evidence | Batched fixed-expiry membership assertions for active relevant scopes |
| POST `/internal/collaboration/control/ack` | R | Monotonic generation/fence acknowledgement |
| PUT `/internal/collaboration/directory` | R matching resource authority | Idempotent content-free directory updates |
| POST `/webhooks/clerk/organizations` | Verified signature on raw bounded body | Signed public ingress, replay/dedupe/reconciliation |
| Existing Stripe webhook | Verified Stripe signature + dedupe | Signed public ingress, payer projection only |
| GET `/api/organizations/:orgId/operations/:id` | U with initiating/management/recovery right | Sanitized asynchronous outcome |
| `/internal/collaboration/policy` (legacy rollout cohort) | Retired | Removed in S20 with the `collaboration_rollout_policy` table; not migrated, no replacement route |

Clerk organization acceptance uses Clerk's supported flow. A verified acceptance event triggers quote revalidation and entitlement command; no secret billing authority is trusted from the event payload. System Clerk permissions govern Clerk components/API; configure explicit Matrix custom permissions for application server checks, as system permissions are not JWT claims.

## Direct home endpoints

All routes below terminate on the home computer; in this release bytes reach it through the platform relay at the origin the resource directory returns, and the home verifies T/D identically regardless of ingress. `D` means direct session derived from T, proof-bound request plus G and fresh evidence. Native clients register their public keys; browsers generate session keys through Web Crypto. Never place reusable resource credentials in URLs/localStorage/logs. WebSocket upgrade uses a narrowly allowlisted single-use, short-lived ticket (redacted at ingress) and verifies possession in the first bounded frame before any output.

| Method + path | Auth / capability |
| --- | --- |
| POST `/api/collaboration/direct-sessions` | T + proof key + exact audience/origin/runtime generation; one-use exchange |
| POST `/api/collaboration/direct-sessions/:id/renew`; DELETE same | Fresh T for renew; bound session for close; resource policy rechecked |
| POST `/api/collaboration/runtimes/:runtimeId/scopes/preflight`; POST `/scopes` | D plus actual resource owner/delegated create authority |
| GET `/api/collaboration/scopes/:scopeId`; GET `/access` | D read, effective capabilities/reasons only |
| GET/POST `/scopes/:scopeId/grants`; PATCH/DELETE `/grants/:grantId` | D read/manage, expected revision |
| POST `/scopes/:scopeId/invitations`; GET `/api/collaboration/invitations/:id`; POST `/:id/accept` or `/decline` | D manage / exact invitee who is a current member of the scope's organization; identifiers outside that organization are not resolved; for an organization-wide share, GET `/api/collaboration/invitations/:id` is side-effect-free (it returns the preview and the caller's pending/active state and never activates anything, so prefetch and list hydration cannot accept), and opening the item means the client calls POST `/api/collaboration/invitations/:id/accept` before any scope hydration; that accept is the one atomic pending-to-active transition, implemented as `INSERT ... ON CONFLICT (grant_id, actor_id) DO UPDATE SET state = 'active', decided_at = EXCLUDED.decided_at, membership_evidence_epoch = EXCLUDED.membership_evidence_epoch WHERE collaboration_grant_activations.state = 'declined'` into `collaboration_grant_activations` in the same transaction that re-checks fresh membership, so a first accept inserts, a repeat accept is a no-op, and an accept after an earlier decline reactivates the same row, and every scope route denies a member without an `active` activation row; POST `/decline` on an organization-wide share writes a durable `declined` activation row for that member only (never affecting the grant or other members), removes the item from that member's `Shared with me`, and is refused once the member is active; pending-invitation T permits only these actions |
| GET/PUT `/scopes/:scopeId/policy`; POST `/policy/preflight` | D read/manage; resolved recipient profile, dependency/readiness report |
| GET/POST `/scopes/:scopeId/access-requests`; POST `/access-requests/:id/decision` (deferred from V1) | D actor request or designated approver |
| GET `/scopes/:scopeId/chat`; GET/POST `/chat/messages`; GET/POST `/discussion/messages`; GET/PATCH `/user-state` | D per Chat content/read/discuss rights; private actor state |
| GET/POST `/scopes/:scopeId/chat/requests`; POST `/chat/requests/:id/cancel` or `/retry`; POST `/chat/approvals/:id/decision` | D+F submit under the effective submit mode; cancel and tool-approval decisions only for the requesting member or the project owner; `/retry` resubmits an interrupted or failed request and is permitted only to the requesting member (the owner may submit a new request but cannot resubmit another member's); payload pins root and V3 funding selection |
| GET `/scopes/:scopeId/project`; GET `/project/inventory`; POST `/project/confirm` | D project read/manage and inventory digest |
| GET/POST `/scopes/:scopeId/project/worktrees`; GET/DELETE `/project/worktrees/:id` (deferred from V1) | D allowed worktree actions |
| POST `/scopes/:scopeId/project/chats`; POST `/project/terminals` | D create with explicit Chat audience/root or sandbox terminal profile; default group Chat is created idempotently on share, join reuses it |
| GET `/scopes/:scopeId/project/git`; POST `/project/git/actions` | D inspect; commit/push/PR execute through the broker under the owner identity for Contributor, no owner approval in V1, requesting member audited |
| POST `/scopes/:scopeId/project/git/operations/:operationId/decision` (deferred from V1) | D resource owner only; one-use expiring approval bound to tree/ref |
| GET/PATCH `/scopes/:scopeId/project/layout` | D read/mutate filtered nodes; personal viewport separate |
| GET `/scopes/:scopeId/files`; GET `/files/:fileId/content`; POST `/files/actions` | D exact catalog action; streaming download/staged upload/commit/rename/delete/move union |
| GET `/scopes/:scopeId/apps/:appId`; POST `/apps/:appId/view`; GET `/apps/:appId/assets/*`; POST `/apps/:appId/actions` | D per-instance asset/view/action policy; isolated renderer origin/CSP, no owner cookies |
| GET `/scopes/:scopeId/terminal`; POST `/terminal/actions`; GET `/terminal/ws` (WS) | D read/control profile; no generic owner PTY |
| GET `/scopes/:scopeId/events` (WS); GET `/sync/events` (WS) | D every batch/replay/input + expiry watchdog; audience-filtered event payloads |
| GET `/scopes/:scopeId/integrations`; POST `/integrations/:connectionId/actions` (deferred from V1) | D+F exact tool/upstream resource; V1 runs use the owner's existing connections through the ordinary run path |
| GET/PUT `/scopes/:scopeId/execution-policy` | D read; only the scope owner changes the single selected V3 source and submit mode. The scope is a project or a standalone Chat; a Chat inside a shared project has no policy of its own and returns the project's. Participants cannot override source/account IDs in run payloads |
| POST `/scopes/:scopeId/lifecycle`; GET `/operations/:id`; GET `/exports/:id` | D distinct archive/delete/transfer/export/recovery capabilities |
| POST `/scopes/:scopeId/transfers` (deferred from V1) | D transfer plus target signed consent; preview/confirm action union |
| Existing shared sync manifest/stage/commit/multipart routes | D exact scope/capability; server-resolved namespace, no broad storage GET URL |

Route suffixes in this table use `/api/collaboration` as prefix unless a complete prefix is shown. S02 expands combined method/path rows to exact router allowlists and schemas; there is no catch-all forwarding route. Personal unrelated gateway APIs keep their existing authentication and are inaccessible through D.

## Peer protocol

POST `/api/collaboration/peer/sessions` verifies P with exact purpose, actor, source/target keys and generation. GET `/peer/operations/:id/manifest`, GET `/peer/operations/:id/chunks/:chunkId`, PUT `/peer/operations/:id/chunks/:chunkId`, POST `/peer/operations/:id/commit`, and POST `/peer/operations/:id/cancel` require the resulting proof-bound P session plus current G on both endpoints. Manifest/chunk IDs are operation-bound, lengths/hashes checked and streaming bounded; commits require matching inventory/fence. No path supplied by a peer is an unchecked filesystem destination.

Deferred from V1: POST `/peer/integrations/:delegationId/actions` requires P+F with exact tool/action/request hash and upstream scope; retry ambiguous remote effects only with connector idempotency or explicit reconciliation. Responses carry approved data only to the authorized requesting runtime/Chat audience. Peer sessions never grant a remote shell or provider token export.

## Ticket/proof and limits

Platform signing is asymmetric; distribute public verification keys, rotate with bounded old-key overlap. Tickets bind actor, nonce, proof-key thumbprint, resource/purpose, logical runtime ID and generation (never a TLS hostname),  maximum actions and expiry. Request signatures bind method, canonical path/query, body digest, conditional headers, session and nonce. Ticket is maximum authority only: local policy may further restrict it. Changing grants invalidates sessions/queued runs; issuer cannot sign an unrestricted owner session.

Initial limits: ticket 30 seconds; identity session five minutes; org evidence 20 seconds from authoritative request start; refresh target ten seconds; stream watchdog five seconds; skew allowance at most five seconds without extending authority. HTTP JSON 96 KiB; webhook 256 KiB; WS frame 64 KiB; paginated rows 100; grants 100/scope; active connections 256/home, 32/scope, four/actor/scope; replay cache 10,000 entries TTL expiry then LRU, rejecting admission if safe replay retention cannot be kept. Transfer four concurrent streams/home, 8 MiB chunks, 30-second idle timeout, resumable checkpoints; whole file quotas reuse configured owner limits. Control lookup five-second timeout; ordinary external APIs ten seconds. Staging TTL 24h except active recovery, recurring symlink-safe cleanup and shutdown drains.

Signed control assertions are fixed-expiry and cannot be refreshed by receipt time. No platform round trip per content chunk; the relay is a byte path, not an authorization call. Local checks plus control refresh enforce leases. Revocation pending/completed states follow data-model.md. Rate-limit auth, bytes, connections, execution and integrations on each home; metadata/control costs remain budgeted on platform.

## Matrix group text exception (deferred from V1)

GET/POST `/api/organizations/:orgId/groups/:groupId/messages` and GET `/events` (WS) terminate on the managed group service with U+O+current group membership, one-use stream ticket and expiry checks. Rooms contain service identity only; no user/AI token joins or direct Matrix bypass. Text only, no file/Chat payload mirroring. These explicit messaging routes are not a generic resource proxy.

## Group Chat, owner source and Git contract

Project share/create idempotently establishes the default shared Chat. Accept/join returns its Chat/resource ID and direct connection metadata, never a new personal copy or new worktree. Discussion is distinct from AI submission; Contributor includes discussion, Viewer is read-only. A run body may select allowed model/harness/root and request ID but never an arbitrary account; server pins the project owner's configured source/policy revision and original requesting actor. Effective submit mode is `members` only when the organization's projected `collaboration.aiSubmission` metadata is `members` and the project policy is not `owner_only`; otherwise `owner_only` rejects member execution while preserving discussion. No provider-eligibility check is performed; the source kind is returned in readiness. No participant OAuth/sign-in or source picker endpoints ship.

Git actions form an explicit union: status/diff, commit, push and pr. Requests use immutable payload hashes and expected refs. The broker checks the member's preset, credential binding and freshness immediately before side effects and executes under the owner identity; owner approval, merge and remote changes are deferred. Ambiguous push/PR results reconcile by operation ID and observed refs before retry. Local agent commands and integration routes must enforce the same Git ceiling. No credential access/forge write bypass through unrestricted shell or broad MCP tokens.

Copy-and-continue is a documented future capability, not an enabled peer action or route. Existing peer transfer keeps its move/fence semantics and cannot be used as a hidden clone API.
