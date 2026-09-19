# Collaboration UX API Delta

This contract is additive to `specs/121-collaboration-session-sharing/contracts/collaboration-api.md`. All unchanged routes, proof rules, role capabilities, queue semantics, terminal-control rules, snapshot boundaries, limits, and safe-error behavior remain authoritative.

## Common Rules

- External routes authenticate the actual signed-in Matrix actor at platform ingress. Platform issues a short-lived proof bound to actor, owner, runtime, scope, method, exact path, body digest, expiry, policy, and authority generation. Gateway verifies it and current owner-local membership before every operation.
- Snapshot tokens are invalid on every route below. Collaboration proofs are invalid for snapshot reads/management.
- Mutations use `Content-Type: application/json`, the existing 96 KiB route body limit, strict Zod 4 schemas, unknown-key rejection, and safe generic client errors.
- IDs use existing collaboration schemas. Discussion text is non-empty after existing bounded-text validation and at most 64 KiB UTF-8. Pages are at most 100 items.
- Existing 10-second platform/runtime request timeout, 2-second DB lock timeout, 5-second statement timeout, no redirect policy, no network-inside-transaction rule, and bounded retry policy apply.
- Responses are `Cache-Control: private, no-store`. Logs may contain safe operation names/error classes, never content, credentials, proofs, owner paths, raw database errors, or invitation identity lookup detail.

## Auth Matrix

| Route | Owner | Editor | Viewer | Pending invitee | Unrelated/revoked | Required action |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /invitations/:id/decline` | Only if target is owner (normally N/A) | Only if target and pending | Only if target and pending | Yes, exact target | No | invitation-target proof + current pending row |
| `GET /scopes/:id/discussion/messages` | Yes | Yes | Yes | No | No | `read` |
| `POST /scopes/:id/discussion/messages` | Yes | Yes | No | No | No | `discuss` |
| `GET /scopes/:id/discussion/user-state` | Yes, own row | Yes, own row | Yes, own row | No | No | `read` |
| `PATCH /scopes/:id/discussion/user-state` | Yes, own row | Yes, own row | Yes, own row | No | No | `read`; current actor row only |

Inherited project membership continues through the existing authority resolver. The routes do not grant direct child membership or item exceptions.

## Invitation Decline

### `POST /api/collaboration/invitations/:invitationId/decline`

Request body reuses the conditional mutation shape:

```json
{
  "clientRequestId": "uuid",
  "expectedRevision": "12"
}
```

Preconditions:

1. Invitation and scope exist.
2. Proof scope matches the invitation scope.
3. Proof actor exactly matches the pending target actor.
4. Invitation is pending, unexpired, and at `expectedRevision`.
5. Same actor/clientRequestId replays only when payload hash matches.

Success `200`:

```json
{
  "scopeId": "uuid",
  "actorId": "user_target",
  "status": "revoked",
  "revision": "13"
}
```

The transaction locks scope then member, changes the pending member to `revoked`, advances revisions/epoch per existing membership mutation rules, appends a content-free audit entry with action `invitation.decline`, creates the existing directory-outbox revoked projection, and emits a scoped changed event. The route never returns whether an unrelated invitation exists.

Safe failures: `401 unauthorized`, `403 forbidden`, `404 not_found`, `409 conflict`, `410 expired`, `422 invalid_request`, `429 rate_limited`, `503 unavailable` through the existing safe error envelope.

## Scope Discussion

### `GET /api/collaboration/scopes/:scopeId/discussion/messages`

Exact query parameters:

```text
after=<decimal revision, default 0>&limit=<1..100, default 50>
```

Success `200`:

```json
{
  "messages": [
    {
      "id": "message_id",
      "scopeId": "uuid",
      "sequence": "18",
      "actor": { "actorId": "user_alice", "displayName": "Alice" },
      "text": "Human-only note",
      "createdAt": "2026-09-17T12:00:00.000Z"
    }
  ],
  "latestSequence": "18"
}
```

For Chat scopes, the adapter performs one database-level query filtered to `purpose=discussion`, `sequence > after`, ordered ascending, and capped by `limit`; it never scans unrelated canonical messages in application code. It must not leak AI request, assistant, tool, system, or owner-only attachment data through this route. For terminal scopes, it reads the additive terminal discussion table with the same bounded query shape. Project scopes return safe `not_found`/`unavailable` unless explicitly enabled by the existing project contract; this feature does not add project discussion.

### `POST /api/collaboration/scopes/:scopeId/discussion/messages`

Request:

```json
{
  "clientRequestId": "uuid",
  "expectedRevision": "42",
  "text": "Human-only note"
}
```

Success `201` returns one discussion message in the same item shape as `GET`. Chat delegates to the existing canonical discussion append. Terminal commits a terminal discussion row through the existing collaboration operation/idempotency pattern. A successful append emits the existing scope `changed` notification after commit. It never creates an AI request, canonical `ai_request`, terminal action, input, paste, or resize.

### `GET /api/collaboration/scopes/:scopeId/discussion/user-state`

Success `200`:

```json
{
  "readThroughSeq": "17",
  "lastOpenedAt": "2026-09-17T12:00:00.000Z"
}
```

Chat and Terminal both read the current actor's scope-level discussion-state row or return `readThroughSeq: "0"`. Normal Chat presentation state remains in `chat_user_state` and cannot mark discussion read (or be marked read by discussion).

### `PATCH /api/collaboration/scopes/:scopeId/discussion/user-state`

Request:

```json
{
  "readThroughSeq": "18"
}
```

At least one supported field is required; this feature supports only `readThroughSeq`. The adapter validates a nonzero Chat cursor identifies a canonical `purpose=discussion` message, validates a terminal cursor is not beyond the latest terminal-discussion sequence, and monotonically advances only the authenticated actor's row. Success `200` uses the same shape as `GET`.

### Existing owner lifecycle export for terminal scopes

`POST /api/collaboration/scopes/:scopeId/lifecycle` with `type: "export"` remains owner-only and uses the existing signed proof, idempotent operation, audit, expiring export storage, and `GET .../exports/:exportId` retrieval path. For a terminal scope, the artifact contains the bounded shared `discussion` message projection and excludes `collaboration_discussion_user_state`. Bounded participant metadata is prepared before locking; the authoritative message read and artifact write share the scope-locking transaction, which rechecks current owner membership, scope kind, lifecycle, revision, and payload hash. Snapshot tokens remain invalid.

## Existing Route Compatibility

- `GET /api/collaboration/scopes/:scopeId/chat/messages` continues returning the complete canonical shared Chat projection for old clients.
- `POST .../chat/messages` continues appending Chat discussion for old clients during compatibility rollout.
- New native clients render the main Chat timeline from canonical shared messages excluding `purpose=discussion`, and use `/discussion/*` for the drawer.
- Once all supported clients have migrated, removal of old mutation aliases requires a separate deprecation specification; this feature does not remove them.

## Discovery and Badge

No new badge endpoint is added. Clients call the existing invited-directory route with `limit=10` and derive:

```text
0       -> no badge
1..9    -> decimal badge
>=10 or nextCursor present -> "9+"
```

The badge contains no owner/resource content. The full destination independently paginates pending and accepted lists, preserves server order, places pending before accepted in presentation, and invalidates after invitation mutations or relevant realtime/focus recovery.

## Native Route Resolution Contract

The following are routing entrypoints, not independent content surfaces:

| Entry | Resolution |
| --- | --- |
| `/shared/chat/:scopeId` | Fetch authorized scope/Chat projection, select native Chat, replace URL/state with native Chat route |
| `/shared/terminal/:scopeId` | Fetch authorized scope/terminal projection, select native Terminal, replace URL/state with native Terminal route |
| `/shared/invitations/:id` | Show invitation review inside Shared with me; accept opens native resource; decline returns to updated list |
| Existing shell selection from Shared with me | Same native Chat/Terminal state transition without standalone page |

Invalid IDs fail before proxying. Feature-off hides navigation and normalizes no collaboration content. Revoked, expired, missing, policy-disabled, and owner-runtime-unavailable outcomes render safe states inside the native application frame without revealing internal routing.

## Proxy, CLI, and Wiring Changes

Exact allowlist additions only:

```text
POST /api/collaboration/invitations/{uuid}/decline
GET  /api/collaboration/scopes/{uuid}/discussion/messages
POST /api/collaboration/scopes/{uuid}/discussion/messages
GET  /api/collaboration/scopes/{uuid}/discussion/user-state
PATCH /api/collaboration/scopes/{uuid}/discussion/user-state
```

- Invitation decline is classified with invitation routes and the same milestone/policy as acceptance.
- Discussion is classified by resolved scope kind: Chat requires current Chat collaboration capability; Terminal requires current terminal collaboration capability. A route string alone never upgrades a milestone.
- Sync-client validation accepts only the exact paths above; no wildcard relaxation.
- Gateway startup injects one discussion adapter with Chat and terminal implementations. Missing terminal storage/wiring returns unavailable and cannot fall back to Chat or personal owner routes.
- Shutdown owns no new external pool or timer. Existing database and event-registry owners remain responsible for lifecycle.

## Required Contract Tests

1. Strict schema success/failure and UTF-8 byte limits.
2. Invite target can decline; owner/unrelated/revoked actors cannot; replay and revision conflict behavior.
3. Platform proof/path/method/body tampering and snapshot-token rejection.
4. Chat discussion projection contains only canonical discussion and preserves author attribution.
5. Terminal discussion append/read/read-state across two actors; viewer POST rejection; revocation race.
6. No discussion operation creates AI requests or terminal actions.
7. Proxy/CLI exact-path allowlisting and capability-mode behavior.
8. Startup integration test proves route registration, adapters, migrations, event notification, and safe shutdown.
9. Terminal discussion messages are present in bounded owner export, removed by authoritative scope deletion, and never confused with personal read state during retry or rollback.
