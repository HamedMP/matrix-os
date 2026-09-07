# Collaboration HTTP and Authorization Contract

**Status:** Proposed interface for implementation; these routes do not exist yet.
**Related:** [plan](../plan.md), [data model](../data-model.md), [realtime](realtime-execution.md).

## Authentication and authority

There are no public content or anonymous acceptance endpoints. All external routes below use verified Matrix identity through platform authentication. A participant does not need a provisioned personal computer. Platform lookup chooses the registered owner runtime; it never grants machine access or exposes an owner credential.

For each forwarded request, platform strips client-supplied actor/proof headers and signs actor, owner, runtime audience, scope (or owner-only creation target), purpose, canonical HTTP method/path/query, mutation-body digest, issue/expiry time, nonce and key ID. Maximum lifetime is 30 seconds. Gateway verifies the proof and current effective membership independently. Signed fields must match the actual forwarded bytes/target. Retry safety uses actor-scoped operation IDs, not proof reuse. Signing follows existing managed-key conventions and constant-time verification; missing keys or owner storage fail closed.

An `AuthorizedCollaborationContext` separates `actorId` from `ownerId` and includes effective scope, role, auth epoch, authority generation and capability. It is constructed by trusted middleware only. Configured-owner fallback, arbitrary forwarded headers, resource IDs, and directory entries cannot construct this context. Platform checks current server rollout policy; runtime verifies a signed policy snapshot with maximum age 30 seconds. Actor removal invalidates current access; stale/expired policy never enables an operation.

Ordinary personal `/vm`, files, app, Chat and terminal routes retain owner-only authentication. Collaboration tickets/proofs are rejected there. Owner legacy routes must also consult the shared-resource authority and capability gates, preventing owners from bypassing shared queue, lease, migration or M1 execution rules.

## Route and role matrix

All paths are under `/api/collaboration`. `S` means `/scopes/:scopeId`. Every row is **private/authenticated**, including invite previews. `Member` means an accepted owner/editor/viewer after effective inherited membership resolution. A pending invitation authorizes only its own bounded preview and acceptance. Roles are checked at the authoritative operation, not just at route entry.

| Method and suffix | Authorized actor | Contract / milestone |
| --- | --- | --- |
| GET `/shared`, `/inbox` | Signed-in actor, own index only | Paginated opaque locators. Hydrate labels from owner runtime after authorization; no titles/content stored in platform. M1. |
| POST `/runtimes/:runtimeId/scopes/preflight` | Verified runtime owner | Selected kind/resource ID; returns eligibility and expiring confirmation token. M1 Chat, M3 terminal, M4 project. |
| POST `/runtimes/:runtimeId/scopes` | Verified runtime owner | Idempotent creation bound to preflight token and expected revision. M4 prepares an unpublished project scope; project publication uses confirm below. |
| GET `S` | Member | Scope, role, participants, lifecycle, capabilities and safe unavailable reasons. |
| GET `S/members` | Member | Accepted participant labels/roles; pending invite details owner-only. |
| POST `S/invitations` | Owner | Verified target account ID and editor/viewer role; reserve capacity transactionally. No implicit contact creation or external email sending. |
| GET `/invitations/:invitationId` | Exact invited actor or inviter | Bounded inviter/target-kind/role/implications preview; no content access. |
| POST `/invitations/:invitationId/accept` | Exact invited actor | Explicit acceptance; recheck expiry, scope state, cohort and current reservation. |
| DELETE `S/invitations/:invitationId` | Owner | Revoke pending invitation; old accept links remain invalid. |
| PATCH `S/members/:actorId` | Owner | Role and expected member revision; cannot remove final owner. |
| DELETE `S/members/:actorId` | Owner, or that member leaving | Conditional revoke/leave; owner must transfer or delete instead of leaving ownerless. |
| GET/PATCH `S/user-state` | Member, own state only | Read position, pin/mute and applicable project viewport; validated per-kind fields. No actor override or shared composer drafts. |
| GET `S/chat`, `S/chat/messages` | Member | Canonical safe Chat projection and paginated history, M1. |
| POST `S/chat/messages` | Owner/editor | Discussion message only; starts zero runs. M1. |
| GET `S/chat/requests` | Member | Ordered accepted requests and attempts, M2. |
| POST `S/chat/requests` | Owner/editor | Explicit AI request; accepted sequence and operation ID; M2 only. |
| POST `S/chat/requests/:requestId/cancel` | Owner; editor for own request | Durable command, current state/author/role check, M2. |
| POST `S/chat/requests/:requestId/retry` | Owner; editor for own request | New attempt linked to original, reauthorized and queued, M2. |
| POST `S/chat/approvals/:approvalId/decision` | Owner | One durable decision claim before adapter call, M2. |
| GET `S/terminal` | Member | Stable ID/incarnation, exit/restore state and current controller, M3. |
| POST `S/terminal/actions` | Per-action matrix below | Discriminated control/lifecycle action; M3. |
| POST `S/connection-tickets` | Member | One-use ticket for exact scope and events/terminal purpose; recheck membership at upgrade. |
| GET `S/project/inventory` | Owner | Complete owned contents, external references, blockers and fingerprint; allowed while preparing, M4. |
| POST `S/project/confirm` | Owner | Confirm whole inventory and membership effects, no exclusion list; starts journaled transition, M4. |
| GET `S/project` | Member | Authoritative shared project projection, M4. |
| GET `S/project/files` | Member | Validated root-relative file/list/search operation with pagination, M4. |
| PUT/DELETE `S/project/files` | Owner/editor | Conditional scoped file mutation; write fence and no path escape, M4. |
| GET `S/project/git` | Member | Bounded project status/diff projection, M4. |
| POST `S/project/git/actions` | Owner/editor | Typed existing Git actions inside project boundary; no arbitrary shell command field. M4. |
| GET `S/project/apps/:appId` | Member | Project app manifest/data projection using scoped bridge, M4. |
| POST `S/project/apps/:appId/actions` | Owner/editor | App-specific schema and role enforced by bridge, M4. |
| GET/PATCH `S/project/layout` | Member read; owner/editor write | Shared layout; node-level conditional revisions. Personal view goes to user-state. M4. |
| POST `S/project/chats`, `S/project/terminals` | Owner/editor | Create child with inherited scope atomically; creator attribution, M4. |
| POST `S/lifecycle` | Owner | Typed archive/restore/transfer/export/delete/recover operations; applicable from first enabled scope kind. |
| GET `S/operations/:operationId` | Initiator or owner | Bounded transition/export/lifecycle progress; no unscoped job lookup. |
| GET `S/exports/:exportId` | Owner | Stream completed owned-content export after current authorization; expiring storage reference, no public download URL. |

Project child Chat/terminal operations use that child's scope ID, whose binding resolves effective membership to the parent. No project ID supplied by the client can redirect an unrelated child's authority. Owner-only preparation routes deliberately permit an unpublished preparing scope; member/content routes do not.

Internal service routes are separate: `PUT /internal/collaboration/directory` accepts idempotent metadata from the authenticated registered runtime for its own owner/generation only; `GET /internal/collaboration/policy` returns signed capability policy to an authenticated registered runtime. Both require service authentication and are not public or reachable using participant proofs/tickets. Policy changes use existing authenticated platform operator configuration, not a new customer endpoint. Directory repair cannot change owner membership.

## Payload and result rules

Zod 4 validates params, queries and bodies before service calls. New IDs are UUIDs; canonical resource IDs retain their existing bounded contracts. Revisions/epochs/sequences are decimal strings. Reject unknown fields, actor/owner/role injection and client absolute paths. All mutation verbs, including DELETE, apply Hono `bodyLimit` before buffering. Default maximum is 96 KiB; file upload has an explicit 2 MiB bounded body exception. Text messages/AI requests are at most 64 KiB UTF-8. Pagination defaults to 50, maximum 100; opaque cursors are scope-bound and at most 512 bytes. Rate/capacity and cleanup bounds are in the [plan](../plan.md).

Every mutation includes `clientRequestId` and, where updating existing state, `expectedRevision`. Replay key is scope+actor+operation kind+request ID and stores a payload hash; different payload on a used key returns conflict. Body-free DELETE supplies bounded request ID/revision headers covered by the signed proof. Only documented canonical request headers participate in that proof.

Project confirmation contains `inventoryToken`, `inventoryHash`, `expectedRevision`, and confirmed membership effects. Tokens expire after 10 minutes and bind owner/scope/generation/inventory/membership. A stale inventory returns conflict with a new preview; the user confirms the complete updated inventory again. There is no `exclude`, `selectedItems`, or per-child private flag.

Terminal action is a strict union: `acquire`, `release`, `renew`, `takeover`, `input`, `paste`, `resize`, `stop`. All bind session incarnation. Input/paste/resize/renew/release require matching holder connection and lease epoch. Acquire is owner/editor with a free lease; owner takeover may invalidate a held lease; editors can acquire only after the current controller releases or the lease expires. Stop is owner or the editor who created the session. Viewers can only observe. Input/paste text is at most 32 KiB per action, terminal dimensions 1–1000 each. No standalone action creates another terminal. WS uses the same dispatcher and schemas.

File paths are root-relative bounded strings (maximum 4096 bytes), resolved against a server-owned root; reject traversal, symlinks or moved-root races using safe directory-relative operations, not string-prefix checks alone. Large transfers must use a separately specified bounded streaming contract before support is advertised; this initial upload limit never permits omitting an existing large file from project sharing/inventory/export. Git and app commands validate their own discriminated action schemas; no generic record cast or unrestricted process/SQL proxy. Read-only app rendering must not trigger mutation indirectly.

Success returns the committed resource/operation reference, revision and capabilities; acceptance of an asynchronous transition is `202` with explicit pending state, never a claim of completion. Errors use bounded allowlisted codes such as `unavailable`, `conflict`, `capacity`, `invalid_request`; generic messages contain no runtime paths, providers, host details, DB errors or credentials. Outsiders get a generic not-found response without resource enumeration. Authenticated members may receive role/capability denial. Missing server dependencies return generic unavailable/5xx, never a fabricated not-found. Clients preserve optimistic input on failure and refresh only the still-active resource.

## Concurrency and legacy gate

Current membership/capability and expected revision are checked inside the same locked transaction as each resource mutation and outbox. Revoke/downgrade increments auth epoch. External writes and terminal actions use a serialized authority fence: no delayed command admitted after revoke commit can execute with the old grant. Operations already handed to an external process retain truthful in-flight status and existing recovery semantics; an authorization transaction cannot undo past execution.

Lifecycle export/delete/transfer operates only on owned state, protects the final owner, and publishes membership/authority changes once. Archive prevents mutations but preserves authorized reads; deletion denies ordinary/export reads and performs owned-content cleanup. Transfer requires explicit successor acceptance and a journaled authority handoff if runtime ownership changes; editing `owner_id` alone is insufficient.

M1 denies shared AI through all start, queue, dispatch, approval, retry, steer, legacy and reconnect paths, including requests by the owner. A private Chat with active or pending personal execution cannot convert until it safely settles. M2 uses the same single queue and durable history. Shared queue reorder/steer is unavailable. Scope conversion never exposes the owner's private files or hidden resume state.

## Required contract tests

Test owner/editor/viewer/pending/expired/revoked/outsider for every route family, including owner legacy bypass and inherited child access. Test proof tampering/replay-purpose substitution, direct runtime access, double acceptance, capacity races, wrong resource kind, stale inventory, query-token allowlist boundaries, duplicate operation payloads, generic error normalization, body limits and downgrade/revoke races. Exercise platform → gateway → authority → actual resource adapter → scoped event delivery with two verified actors; route mocks alone do not pass a milestone.
