# Direct collaboration contracts and auth matrix

S02 freezes strict Zod 4 contracts and package exports before dependent packets. This replaces the previous platform-forwarded resource API design. Every endpoint below is private unless explicitly called signed public ingress. No resource route may be forwarded by the platform after cutover.

## Wire rules

Mutations require UUID clientRequestId, record expectedRevision where applicable, and a bounded discriminated payload. Same idempotency key/different payload conflicts. Validate all identifiers/path/query/body at boundary; no arbitrary target URL, owner filesystem path, payer or DB namespace. Resolve paths by catalog identity with symlink/hardlink escape checks. POST/PUT/PATCH/DELETE apply bodyLimit before buffering. Conditional DELETE uses validated headers where existing clients need bodyless DELETE. Generic errors only; hidden resource existence returns not-found. Cookies require exact Origin/CSRF; direct proof-authenticated requests also validate allowed client origin and proof binding. No wildcard CORS. No environment flag, milestone or rollout cohort gates any route: the actor's current membership or guest admission in the resource's organization is checked on every collaboration route, WebSocket upgrade, queue claim, tool invocation and integration action, and missing signing/origin configuration fails closed.

`U`: verified Clerk/app/native/CLI actor; `O`: fresh Clerk org role/permission projection; `R`: enrolled runtime asymmetric identity; `T`: one-use platform-signed connection/operation ticket plus client proof of possession; `G`: local current grant/policy, always derived from the scope's organization; `F`: exact approved funding/credential delegation; `P`: authenticated peer runtime plus T naming actor, operation and both endpoints. Selected org, custom headers or network reachability are never authority.

## Platform control endpoints

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
| GET `/api/collaboration/shared`; GET `/api/collaboration/inbox` | U+O as needed | Safe resource routing/discovery metadata; client hydrates direct |
| POST `/api/collaboration/connections` | U+O as needed | Exact resource/purpose/client public key; directory-resolved endpoint and T, no content |
| POST `/api/collaboration/peer-operations` | U+G consent receipts + R as applicable | Transfer/tool/policy-sync tickets, exact source/target/action/digest; no arbitrary command |
| POST `/internal/collaboration/runtime-endpoints` | R plus enrollment bootstrap verification | Register exact verified TLS endpoint, protocol/key generation; SSRF-safe validation |
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

All routes below terminate on the registered computer origin. `D` means direct session derived from T, proof-bound request plus G and fresh evidence. Native clients register their public keys; browsers generate session keys through Web Crypto. Never place reusable resource credentials in URLs/localStorage/logs. WebSocket upgrade uses a narrowly allowlisted single-use, short-lived ticket (redacted at ingress) and verifies possession in the first bounded frame before any output.

| Method + path | Auth / capability |
| --- | --- |
| POST `/api/collaboration/direct-sessions` | T + proof key + exact audience/origin/runtime generation; one-use exchange |
| POST `/api/collaboration/direct-sessions/:id/renew`; DELETE same | Fresh T for renew; bound session for close; resource policy rechecked |
| POST `/api/collaboration/runtimes/:runtimeId/scopes/preflight`; POST `/scopes` | D plus actual resource owner/delegated create authority |
| GET `/api/collaboration/scopes/:scopeId`; GET `/access` | D read, effective capabilities/reasons only |
| GET/POST `/scopes/:scopeId/grants`; PATCH/DELETE `/grants/:grantId` | D read/manage, expected revision |
| POST `/scopes/:scopeId/invitations`; GET `/api/collaboration/invitations/:id`; POST `/:id/accept` or `/decline` | D manage / exact invitee who is a current member or admitted guest of the scope's organization; identifiers outside that organization are not resolved; pending-invitation T permits only these actions |
| GET/PUT `/scopes/:scopeId/policy`; POST `/policy/preflight` | D read/manage; resolved recipient profile, dependency/readiness report |
| GET/POST `/scopes/:scopeId/access-requests`; POST `/access-requests/:id/decision` | D actor request or designated approver; exact actions and expiry |
| GET `/scopes/:scopeId/chat`; GET/POST `/chat/messages`; GET/POST `/discussion/messages`; GET/PATCH `/user-state` | D per Chat content/read/discuss rights; private actor state |
| GET/POST `/scopes/:scopeId/chat/requests`; POST `/chat/requests/:id/cancel` or `/retry`; POST `/chat/approvals/:id/decision` | D+F submit/cancel/approve; payload pins root and V3 funding selection |
| GET `/scopes/:scopeId/project`; GET `/project/inventory`; POST `/project/confirm` | D project read/manage and inventory digest |
| GET/POST `/scopes/:scopeId/project/worktrees`; GET/DELETE `/project/worktrees/:id` | D allowed worktree actions; cleanup/lease/fingerprint checks |
| POST `/scopes/:scopeId/project/chats`; POST `/project/terminals` | D create with explicit Chat audience/root or sandbox terminal profile; default group Chat is created idempotently on share, join reuses it |
| GET `/scopes/:scopeId/project/git`; POST `/project/git/actions` | D inspect/propose; commit/merge/push/PR execute only with exact owner-approved operation, typed refs/tree digest and CAS; no raw Git on restricted view |
| POST `/scopes/:scopeId/project/git/operations/:operationId/decision` | D resource owner only; one-use expiring approval bound to tree/ref, remote/branch and exact action, never a generic forge token |
| GET/PATCH `/scopes/:scopeId/project/layout` | D read/mutate filtered nodes; personal viewport separate |
| GET `/scopes/:scopeId/files`; GET `/files/:fileId/content`; POST `/files/actions` | D exact catalog action; streaming download/staged upload/commit/rename/delete/move union |
| GET `/scopes/:scopeId/apps/:appId`; POST `/apps/:appId/view`; GET `/apps/:appId/assets/*`; POST `/apps/:appId/actions` | D per-instance asset/view/action policy; isolated renderer origin/CSP, no owner cookies |
| GET `/scopes/:scopeId/terminal`; POST `/terminal/actions`; GET `/terminal/ws` (WS) | D read/control profile; no generic owner PTY |
| GET `/scopes/:scopeId/events` (WS); GET `/sync/events` (WS) | D every batch/replay/input + expiry watchdog; audience-filtered event payloads |
| GET `/scopes/:scopeId/integrations`; POST `/integrations/:connectionId/actions` | D+F exact tool/upstream resource + required approval; output audience ceiling |
| GET/PUT `/scopes/:scopeId/execution-policy` | D read; only owner changes the single selected V3 source and submit mode. Participants cannot override source/account IDs in run payloads |
| POST `/scopes/:scopeId/lifecycle`; GET `/operations/:id`; GET `/exports/:id` | D distinct archive/delete/transfer/export/recovery capabilities |
| POST `/scopes/:scopeId/transfers` | D transfer plus target signed consent; preview/confirm action union |
| Existing shared sync manifest/stage/commit/multipart routes | D exact scope/capability; server-resolved namespace, no broad storage GET URL |

Route suffixes in this table use `/api/collaboration` as prefix unless a complete prefix is shown. S02 expands combined method/path rows to exact router allowlists and schemas; there is no catch-all forwarding route. Personal unrelated gateway APIs keep their existing authentication and are inaccessible through D.

## Peer protocol

POST `/api/collaboration/peer/sessions` verifies P with exact purpose, actor, source/target keys and generation. GET `/peer/operations/:id/manifest`, GET `/peer/operations/:id/chunks/:chunkId`, PUT `/peer/operations/:id/chunks/:chunkId`, POST `/peer/operations/:id/commit`, and POST `/peer/operations/:id/cancel` require the resulting proof-bound P session plus current G on both endpoints. Manifest/chunk IDs are operation-bound, lengths/hashes checked and streaming bounded; commits require matching inventory/fence. No path supplied by a peer is an unchecked filesystem destination.

POST `/peer/integrations/:delegationId/actions` requires P+F with exact tool/action/request hash and upstream scope; retry ambiguous remote effects only with connector idempotency or explicit reconciliation. Responses carry approved data only to the authorized requesting runtime/Chat audience. Peer sessions never grant a remote shell or provider token export.

## Ticket/proof and limits

Platform signing is asymmetric; distribute public verification keys, rotate with bounded old-key overlap. Tickets bind actor, nonce, proof-key thumbprint, resource/purpose, runtime/endpoint audience, generations, maximum actions and expiry. Request signatures bind method, canonical path/query, body digest, conditional headers, session and nonce. Ticket is maximum authority only: local policy may further restrict it. Changing grants invalidates sessions/queued runs; issuer cannot sign an unrestricted owner session.

Initial limits: ticket 30 seconds; identity session five minutes; org evidence 20 seconds from authoritative request start; refresh target ten seconds; stream watchdog five seconds; skew allowance at most five seconds without extending authority. HTTP JSON 96 KiB; webhook 256 KiB; WS frame 64 KiB; paginated rows 100; grants 100/scope; active connections 256/home, 32/scope, four/actor/scope; replay cache 10,000 entries TTL expiry then LRU, rejecting admission if safe replay retention cannot be kept. Transfer four concurrent streams/home, 8 MiB chunks, 30-second idle timeout, resumable checkpoints; whole file quotas reuse configured owner limits. Control lookup five-second timeout; ordinary external APIs ten seconds. Staging TTL 24h except active recovery, recurring symlink-safe cleanup and shutdown drains.

Signed control assertions are fixed-expiry and cannot be refreshed by receipt time. No platform round trip per content chunk; local checks plus control refresh enforce leases. Revocation pending/completed states follow data-model.md. Rate-limit auth, bytes, connections, execution and integrations on each home; metadata/control costs remain budgeted on platform.

## Matrix group text exception

GET/POST `/api/organizations/:orgId/groups/:groupId/messages` and GET `/events` (WS) terminate on the managed group service with U+O+current group membership, one-use stream ticket and expiry checks. Rooms contain service identity only; no user/AI token joins or direct Matrix bypass. Text only, no file/Chat payload mirroring. These explicit messaging routes are not a generic resource proxy.

## Group Chat, owner source and Git contract

Project share/create idempotently establishes the default shared Chat. Accept/join returns its Chat/resource ID and direct connection metadata, never a new personal copy or new worktree. Discussion is distinct from AI submission; Contributor includes discussion, Viewer is read-only. A run body may select allowed model/harness/root and request ID but never an arbitrary account; server pins the project owner's configured source/policy revision and original requesting actor. `owner_only` submit mode rejects collaborator execution while preserving discussion/proposals; `delegated` requires provider-eligible source and explicit actor capability. No participant OAuth/sign-in or source picker endpoints ship.

Git actions form an explicit union: status/diff, propose-commit, propose-merge, propose-push, propose-pr, owner-approve and execute-approved. Requests/decisions use immutable payload hashes, expected refs/tree digest and exact owner identity. Broker checks grants, owner decision, protected branches, credential binding and freshness immediately before side effects. Ambiguous push/PR results reconcile by operation ID and observed refs before retry. Local agent commands and integration routes must enforce the same Git ceiling. No credential access/forge write bypass through unrestricted shell or broad MCP tokens.

Copy-and-continue is a documented future capability, not an enabled peer action or route. Existing peer transfer keeps its move/fence semantics and cannot be used as a hidden clone API.
