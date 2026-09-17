# Data Model: Native Collaboration UX Redesign

## Existing Authoritative Records (Unchanged)

### Collaboration scope and membership

`collaboration_scopes` remains the resource/owner authority. `collaboration_members` remains the only role and invitation authority. Roles remain `owner | editor | viewer`; membership states remain `pending | accepted | revoked | expired`. Direct and inherited membership behavior is unchanged.

Declining an invitation updates the existing pending member row to `revoked`; it does not add a new grant record or status. Scope revision, auth epoch where required by existing transition rules, member revision, audit, event, and directory outbox are committed under the existing scope/member lock order.

### Canonical Chat

`chats`, `chat_messages`, canonical queue/request/approval records, and `chat_user_state` remain the only shared Chat content and execution records. Message `purpose` remains:

- `ai_request`: a human prompt shown on the normal right side with actor attribution.
- `assistant` / `system`: AI/tool/system presentation shown through existing normal renderers.
- `discussion`: a human-only note shown only in the discussion layer.

The new discussion route is a filtered projection over these rows; no Chat row is copied or migrated.

### Terminal

The existing terminal registry, incarnation, execution generation, retained output, controller lease/epoch, and action records remain authoritative. Discussion records never authorize or represent terminal input.

### Platform directory

The platform directory continues to hold only routing/discovery metadata: actor recipient, scope/runtime/owner identifiers, kind, authority generation, invitation ID, and `invited | accepted | revoked` status. It stores no prompt, Chat content, terminal output, discussion text, draft, or member roster.

## Additive Owner-Local Records

### `collaboration_discussion_messages`

Used only when `collaboration_scopes.kind = 'terminal'`. Chat discussions remain canonical Chat messages.

| Field | Type / constraint | Meaning |
| --- | --- | --- |
| `scope_id` | UUID FK collaboration scope | Authority and lifecycle boundary |
| `sequence` | BIGINT, positive | Monotonic terminal-discussion cursor within scope |
| `id` | bounded resource ID, unique | Stable message identity |
| `actor_id` | existing actor ID constraints | Actual authenticated author |
| `text` | TEXT, 1–64 KiB UTF-8 | Plain human-only note |
| `scope_revision` | BIGINT, nonnegative | Authoritative revision committed with append |
| `created_at` | TIMESTAMPTZ | Commit time |

Primary key: `(scope_id, sequence)`. Unique key: `(scope_id, id)`. Append happens in the scope transaction after current `discuss` authorization and expected-revision validation. A matching `collaboration_operations` row supplies idempotency by actor/client request/payload hash.

### `collaboration_discussion_user_state`

Used for terminal discussion only. Chat discussion read state delegates to existing `chat_user_state`.

| Field | Type / constraint | Meaning |
| --- | --- | --- |
| `scope_id` | UUID FK collaboration scope | Terminal discussion thread |
| `actor_id` | existing actor ID constraints | State owner |
| `read_through_seq` | BIGINT, nonnegative | Greatest discussion sequence acknowledged |
| `last_opened_at` | TIMESTAMPTZ nullable | Personal presentation metadata |
| `updated_at` | TIMESTAMPTZ | Last authoritative update |

Primary key: `(scope_id, actor_id)`. Updates use `GREATEST(existing, submitted)` and reject a cursor beyond the current terminal-discussion sequence. These rows are personal state and are excluded from exports and directory events unless a future explicit contract says otherwise.

## Shared Projection Types

### Discussion message

```text
id
scopeId
sequence
actor { actorId, displayName, avatarUrl? }
text
createdAt
```

`avatarUrl` is optional presentation metadata resolved through an existing safe participant projection; absence falls back to initials/icon. The stored record keeps actor ID, not display name/avatar snapshots, unless the existing participant contract is intentionally extended.

### Discussion page

```text
messages[0..100]
nextCursor?
latestSequence
```

Messages are ascending for append-to-thread rendering. A cursor is scope-bound and opaque at the platform boundary. Chat adapter maps canonical sequence; terminal adapter maps terminal discussion sequence.

### Discussion user state

```text
readThroughSeq
lastOpenedAt?
```

Unread is derived client-side as `latestSequence > readThroughSeq`; it is not stored as a second boolean.

### Session collaboration projection

Serializable client state derived from existing responses:

```text
scopeId, resourceId, resourceKind, lifecycle
owner, role, capabilities, authorityGeneration, revision
members[] (only authorized visibility)
discussion { latestSequence, readThroughSeq, unread }
queueSummary? / terminalController?
availability
```

No methods, AbortControllers, DOM nodes, sockets, auth tokens, drafts, or owner credentials are stored in shared Zustand state. Actions live outside state or use stable store methods already established by the project.

### Private draft keys

```text
chat prompt:      actorId + chatId
discussion note: actorId + scopeId + "discussion"
```

Draft text and attachment preparation remain local to the current actor. Discussion never reuses the prompt draft key.

## State Transitions

### Invitation decline

```text
pending --decline by target, current revision--> revoked
pending --expire--> expired
pending --accept by target--> accepted
pending --revoke by owner--> revoked
accepted/revoked/expired --decline replay with same request--> prior idempotent result or safe conflict
```

Decline cannot target another actor and cannot be performed with owner identity substituted for the invitee.

### Discussion append

```text
authorized editor/owner + matching revision
  -> idempotency lookup
  -> lock/re-authorize current scope/member epoch
  -> append canonical Chat discussion OR terminal discussion row
  -> advance resource/scope revision as existing adapter requires
  -> append scoped collaboration event
  -> commit
  -> notify existing event registry
```

Viewer, revoked, expired, disabled, wrong-scope, stale-revision, oversized, and duplicate-ID/different-payload submissions do not append.

### Discussion read state

```text
readThroughSeq' = max(current readThroughSeq, submitted readThroughSeq)
0 <= readThroughSeq' <= latest discussion sequence
```

Opening/closing the drawer is not a shared transition. The UI updates read state only after visible messages are rendered/observed according to existing Chat read-state conventions.

## Migration and Rollback

- Add tables/indexes through the existing idempotent collaboration database bootstrap/version mechanism.
- No Chat data backfill and no platform content migration.
- Existing clients and `/chat/messages` remain valid during rollout.
- Rollback stops using new terminal discussion routes but retains their rows; it does not delete or reinterpret data.
- Terminal discussion messages are included in the owning scope's bounded owner export and are removed by the authoritative scope-deletion transaction. Personal discussion read-state rows are removed with the scope but excluded from shared-resource exports. Final enablement is blocked until export, deletion, rollback, and retry behavior have real-Postgres coverage.
