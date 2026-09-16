# Stable chat activity and independent title versions

Chats are ordered by the server's persisted `activity_at DESC, id ASC`. Creation supplies the initial activity timestamp. A newly admitted user turn, queued submission, or successfully accepted direct steer advances it in the same transaction as that input. Retries of an already admitted request, queue claiming, run output/completion, navigation, pins, project changes, and renames do not advance it. Historical rows are backfilled once from creation and committed user/queued input, never background `updated_at`.

List cursors are version 2 and carry the precise activity timestamp and ID. Old version 1 list cursors are rejected so they cannot silently paginate in the wrong ordering. Message cursors are unchanged. Pagination is a live keyset view: a new user submission can move an unseen chat ahead of a cursor; refresh from the first page to see new activity. Background execution alone cannot cause page gaps or duplication.

The existing title endpoint now accepts `{ expectedTitleVersion, title }`. PostgreSQL compares the title version in the UPDATE, increments it and the global event revision atomically, and writes the outbox event in the same transaction. Run writes never change the title version. An automatic title update also requires `title_manual = false`; migrated titles are conservatively manual. Initial prompt naming remains creation-only. Internal legacy metadata title writes increment the title version and mark the title manual too.

| Route | Authentication | Boundary |
| --- | --- | --- |
| GET /api/chats | Existing authenticated request principal | Owner-scoped repository, bounded query and versioned cursor |
| PATCH /api/chats/:chatId/title | Existing authenticated request principal | Owner-scoped conditional write; existing bodyLimit; strict bounded Zod input |

Web Canvas, Web Desktop and Web Mobile share the hook/editor. Electron Desktop uses the same versioned record merge helper. Failed renames retain the local draft and permit explicit retry. Lists, details, stream content and rename responses reconcile title versions independently of the transcript revision. A title response must not advance the transcript's stream cursor. Native Mobile preserves the canonical server list order and has no title rename surface in this checkout.

The metadata/list implementation is extracted from the oversized repository facade. Queue and steering repositories receive only activity timestamp writes in existing input transactions. Their future extraction boundary is enqueue/admission versus queue lifecycle/claiming; no additional queue orchestration is introduced here.

## Validation

- Regression tests were red before implementation for missing activity metadata, title CAS, and editor retries.
- `tests/gateway/chat-order-title.test.ts` supports the existing PGlite harness and a disposable real PostgreSQL database via `CHAT_TEST_DATABASE_URL`. The latter exercises overlapping transactions, using a unique schema per test and dropping it after each test. Never point this variable at an owner or production database.
- Coverage includes concurrent run updates, deterministic pagination, new submissions versus replay/rejection, queue admission, competing renames, automatic naming protection, migration, and reload persistence.
- Client tests cover independent title/transcript versions, stale list/detail/rename responses, draft retention and explicit retry, and existing shared-surface rename interactions.
- Public documentation follow-up is unnecessary for these corrections to existing behavior; this note records the developer-facing contract change. Live release validation must use a disposable runtime before promoting a customer host bundle.
