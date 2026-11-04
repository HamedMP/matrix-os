# ENG93 retained thread execution fence

Source: ENG93 PG rerun on8be2b9f4 and its independent local review. Both supported canonical admission modes accepted a retained thread and started the synthetic adapter. No source is copied from an unmerged PR.

## Minimal boundary

- Query live thread existence by exact owner_id/chat_id/kind and removed_at, before direct lookup or ordinary fallback. Filter before LIMIT1; never infer absence from the16-item binding list.
- Raise existing BotEntryError unavailable. No thread creation/execution feature, DDL, migration renumbering, grant or identity changes.
- Revalidate the lookup before undefined/history-only context can return, covering Retry and provider dispatch.
- Revalidate before recovered queue claim, so retained thread work cannot create a new run before being refused. Skip only an explicitly typed thread refusal for that Chat; continue other owner queues and ordinary Turn/Retry. Database errors still propagate. Do not delete or rewrite queued owner data.
- Recover with an owner/type-scoped keyset cursor so retained thread queues cannot permanently occupy the first20 slots. Each pass reads at most2 pages and scans at most20 Chats; cursors have a64-owner LRU cap and are cleared on shutdown. A cursor changes scan order only, never authority. Restart/eviction restarts the scan safely. Read/dispatch errors propagate, and only examined Chats advance the cursor. Generic queue SQL depends on Chat tables only.

| Existing internal entry | Authorization source | Fence |
|---|---|---|
| New canonical turn | trusted principal plus owner-scoped Chat | prepare, before catalog/admitTurn |
| Retry | owned persisted turn/run plus principal | revalidate, before catalog/admitRetry |
| Recovered personal queue | owner-scoped queue repository | before claim creates run |
| Provider dispatch | owner/run scope | revalidate before adapter |

All lookup values remain SQL parameters. Missing storage dependencies/errors fail closed by propagation. No unbounded cache or external call is introduced. Ordinary/no-thread/direct/group lookup results stay unchanged; personal lookups add one bounded existence query. Ordinary queue recovery now rotates bounded candidate pages rather than repeatedly starting at the first20 IDs; non-personal scope does not query personal bindings. Each fence reads current metadata; no authorization result is cached.

## Tests and evidence

Preserve the two real-PG RED cases separately. Non-PG tests use a real SQL compiler with inert synthetic rows, inspect owner/chat/live/kind SQL, and cover thread beyond16 results, mixed bindings, foreign owner/chat, removed rows, database errors, supported admission modes, contextless/history-only Retry and recovered queue claim. Ordinary controls stay available. Cover20 retained thread queues followed by ordinary Chat21 on the next pass, cursor owner/type isolation, wrap,64-owner eviction, errors and pending-read shutdown. Inspect compiled owner/cursor/LIMIT SQL without a live database. Repeat real PG only when parent authorizes it; synthetic tests do not establish PostgreSQL execution semantics.

## Large-file extraction plan

The existing orchestrator, queue repository and repository facade exceed1000 lines. Extract candidate SQL and bounded scan state into focused queued-chat-candidates.ts and queue-recovery.ts now; leave only delegation/lifecycle wiring in the large files. Before future queue behavior, extract dispatchNextQueued into a focused queue-dispatch helper with injected admission checks, claim repository, adapter/start functions and clock. Keep the capped dispatch registry and close/drain lifecycle owned by the orchestrator, preserve claim transaction scope, and retain queue recovery tests. Continue extracting queue operations behind the repository facade before adding further behavior there. Avoid a broad refactor in this launch fence.

## Deferred boundary

Historical v9 identity compatibility is continued in [eng93-migration-compatibility.md](eng93-migration-compatibility.md): independently preserve deployed v9 SQL and append unpublished routines as v10. Unmerged2759 is not imported; historical migration rows remain immutable. This patch does not qualify concurrent administrative metadata rewrites or real external effects; next approved PG run must verify the new entry fences. Public documentation remains in the separate site repository before release; do not publish unsupported thread functionality.
