# Dedicated conversations for saved custom Bots

## Behavior

Every enabled, active saved definition has its own Bot conversation, whether it has a recipe reference or retains a custom executor. Opening from the sidebar or selecting a Bot mention explicitly ensures that conversation and navigates there. Reopening, renaming and application restarts retain the same owner-scoped identity. The source ordinary Chat, draft, attachments and historical mixed-Agent messages remain intact. A populated destination keeps its draft and reports the collision instead of overwriting it.

Custom definitions retain their exact saved executor, model/options, instructions, recipe configuration, revisions, grants and history. First opening adds a canonical Chat and binding; it does not edit definition files, migrate grants, execute a request or enroll the Bot in a recipe. A missing saved model remains visible as unavailable, with sending disabled. Editing unchanged unavailable selections is allowed for identity text. Selecting a different ready model is explicit and subject to existing admission rules, including Jev qualification.

Recipe Bots continue through `matrix_bot` admission. Custom Bots use the existing canonical saved-Agent resolver, durable context, harness admission, queue/retry revalidation and history. The server chooses the exact bound active definition; alternate Agent or Chat references cannot redirect it. Custom executors requiring Full access need explicit consent for each request, bound to the authenticated client, Chat and exact Bot revision. Accepted sends reset consent. Custom controls do not read recipe-only tasks, authority or memory; they explain unavailable recipe capabilities. Unknown identity or failed definition loading disables sending and ordinary-model controls.

## Persistence and concurrency

No DDL or schema version change is introduced. `custom-direct-v1` derives stable creation IDs from owner ID and exact Bot ID, independent of display name. Ensure locks the existing personal Agent owner row used by create/update/archive and performs canonical Chat creation, direct binding and outbox event in one Postgres transaction. Repeat and concurrent requests return the one active private conversation. File data is never changed by ensure. A transaction failure leaves no partial Chat/binding/event. Removed bindings, archived conversations, canonical `chat_deletions` tombstones and occupied deterministic Chat/request IDs produce a conflict and are never resurrected or adopted. Missing or archived definitions cannot be opened.

GET identity lookups remain read-only. Adapting an existing owner happens lazily on the first explicit POST after upgrading the runtime; no per-owner manual SQL rewrite or fleet backfill is required. Runtime rollout and per-owner schema bootstrap remain separate release gates.

## Endpoint authentication and limits

| Route | Authentication | Public | Behavior |
| --- | --- | --- | --- |
| GET `/api/chat-agents/:agentId/direct-chat` | Existing gateway authenticated personal principal | No | Read active binding; no create |
| POST `/api/chat-agents/:agentId/direct-chat` | Existing gateway authenticated personal principal | No | Ensure/open exact owned active definition |
| GET `/api/chats/:chatId/bot` | Existing gateway authenticated personal principal | No | Reverse owned binding identity |

POST uses streaming body limit 64 KiB, strict empty-object JSON schema and validated Bot ID. Org scope is rejected. Owner ID comes exclusively from the authenticated principal. Safe allowlisted errors distinguish missing, conflict and unavailable conditions; internal failures are logged and never returned. Owner lock timeout is five seconds. Existing canonical Chat and file validation/idempotency limits apply.

## Applicable surfaces and verification

Shared presentation derivation covers Web Canvas, Web Desktop, Web Mobile and Electron Desktop. Canonical server behavior is headless and common to all clients. Native Mobile parity is the dependent [ENG-144](https://linear.app/matrix-os/issue/ENG-144) delivery layer: it must reuse the same execution presentation and exact revision consent semantics, display only supported permission choices, and pass real-device acceptance before shipping. This core layer leaves existing Native Mobile behavior unchanged; Native parity is not claimed as delivered until that gate passes.

Regression evidence must exercise transaction rollback and pooled Postgres concurrent creation/archive serialization, retained saved harness execution and multi-turn history, queue/retry revalidation, no grants/file changes, foreign owner and archived identity rejection, navigation/draft preservation, unavailable saved routes, focused editing, recipe capability read suppression and consent reset across applicable surfaces. Preview VPS and Electron Desktop acceptance must use an exact immutable head and verify ordinary Chats independently.

## Documentation deliverable

A separate PR in private `FinnaAI/matrix-os-site`, under `content/docs/`, documents dedicated custom Bot opening, retained executor availability, consent and recipe-only capabilities. No private owner identifiers or incident snapshots belong in these public specs or docs.
