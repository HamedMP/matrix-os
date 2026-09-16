# Chat read state

## Behavior and scope

Electron Desktop, Web Desktop, Web Canvas, and Web Mobile expose Mark as unread
as the first item in each chat-list context menu. An unread chat offers Mark as
read instead. Existing menu items keep their relative order. Unread indicators
and an All/Unread list filter share server-owned state across clients connected
to the same runtime. Running, approval, input-required, and error indicators
remain separate from unread state.

A committed assistant reply beyond the user's read cursor is unread. Outgoing
messages, tool activity, and partial streaming messages do not create unread
notifications. Opening a loaded conversation in a focused, visible view advances
the cursor only through committed assistant messages actually delivered to that
view. A manual unread mark received during the current visit survives background
refreshes and new replies until the user leaves and reopens the conversation or
explicitly marks it read. Browser focus alone does not override a manual mark.

Native Mobile does not yet expose this new control; extending its native chat
list is an explicit platform limitation of this desktop/web feature. Older
fallback chat stores do not acquire a second local unread implementation.

## Persistence and concurrency

The existing owner-controlled Postgres `chat_user_state` row is authoritative.
`marked_unread` holds the explicit reminder, `read_through_seq` never moves
backwards, and `read_state_version` orders changes independently of Chat content
revisions. Read acknowledgements include the version and displayed sequence;
stale acknowledgements are no-ops, so they cannot clear a newer manual mark.
Explicit unread actions advance the version even if already marked unread.

The transaction locks the owned Chat and user-state rows and writes an outbox
invalidation before commit. Read updates do not reorder chats or invalidate an
in-progress turn's content revision. Responses merge only their read projection
into newer client records. Existing history starts read during the one-time
schema upgrade; repeat bootstraps preserve user choices.

Unread filtering executes before cursor pagination. UI pages and subscriptions
remain bounded by the existing list limits and event-source policies.

## Auth and validation

| Route | Auth | Input and result |
| --- | --- | --- |
| PATCH /api/chats/:chatId/read-state | Existing verified runtime principal; owned Chat only | 4 KiB body limit, bounded Chat ID, strict discriminated action schema; safe Chat record |
| GET /api/chats?unread=true | Existing verified runtime principal; owner-scoped list | Strict true/false query, existing bounded pagination |
| Existing Chat event streams | Existing authenticated SSE/WS transport | Existing owner-scoped `chat.user_state_updated` invalidation |

No caller-provided owner or principal is accepted. Future read cursors are
rejected. Unknown errors use the existing safe route mapper. No provider calls,
new pools, timers, or persistent client-side read-state stores are introduced.

## Implementation and evidence

- Keep read-state SQL and projection in `read-state-repository.ts`; the existing
  large ChatRepository only delegates and owns its transaction/outbox boundary.
- Reuse shared read/merge helpers and visible-view hook across desktop and web.
- Add regression tests first for persistence, stale reads, concurrent replies,
  owner isolation, bounded input, filtering before pagination, and menu ordering.
- Verify hidden/unfocused views, manual marks during the current visit, and
  subsequent reopen behavior. Check dark/light theme and narrow windows.
- Publish the implementation PR and a separate documentation PR in
  `FinnaAI/matrix-os-site` under `content/docs/` explaining the action and filter.
- Follow worktree-pr-monitor: current-head Greptile 5/5, then ready-for-ci and
  triggered CI passing. Do not merge as part of this task.
