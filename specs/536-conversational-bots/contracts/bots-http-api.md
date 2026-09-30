# Bots HTTP API

Gateway routes for conversational bots. Additive to the canonical Chat API (`packages/contracts/src/canonical-chat-api.ts`) and the chat-agent routes (`packages/gateway/src/chat/agent-routes.ts`). Schemas are Zod 4 in `packages/contracts/src/bots/`.

## Common rules

- Every route authenticates the Matrix principal with the existing request-principal middleware. Bot identity never substitutes for a human principal.
- Mutations, including DELETE, use Hono `bodyLimit` (64 KiB unless stated) and strict schemas that reject unknown keys.
- Path and query parameters are validated at the route with Zod before any service call: `agentId` uses the existing `ChatAgentIdSchema` (`^bot_[a-z0-9]{8,64}$`), `chatId` uses `CanonicalChatIdSchema`, and server IDs are `<prefix>_[A-Za-z0-9_-]{8,64}` (`in_`, `gr_`, `mem_`, `task_`, `rt_`, `cr_`). Cursors are ≤512 bytes and `limit` is 1-100.
- Request IDs are `CanonicalChatRequestIdSchema` (`req_...`), and revisions are positive integers, matching the existing chat-agent routes.
- Errors come from one typed mapper:
  - `400 invalid_request`
  - `401 unauthorized`
  - `403 forbidden`
  - `404 not_found` (only for resources the principal could otherwise see)
  - `409 conflict` (revision or idempotency)
  - `429 rate_limited`
  - `503 unavailable` (missing dependency or misconfiguration)
- Bodies carry allowlisted `code` values and a generic `message`. Responses never include provider names, raw database errors, paths, connection secrets, or Zod issues.
- Responses are `Cache-Control: private, no-store`. Explicit CORS allowlist; no wildcard.
- REST mutations publish canonical outbox events only after commit.

## Auth matrix

| Route | Owner | Shared-chat editor | Shared-chat viewer | Guest with AI permission | Unrelated |
|---|---|---|---|---|---|
| `GET /api/chat-agents/bot-recipes` | Launch metadata | No | No | No | No |
| `POST /api/chat-agents/instantiate` | Yes | No | No | No | No |
| `GET /api/chat-agents/:agentId/direct-chat` | Live direct Chat ID or null | No | No | No | No |
| `GET /api/chats/:chatId/bot` | Direct bot ID or null | No | No | No | No |
| `GET /api/chats/:chatId/bot-tasks` | Up to 20 open tasks | No | No | No | No |
| `GET /api/chat-agents/:agentId/authority` | Full | Group-visible subset (M3) | Group-visible subset (M3) | Group-visible subset (M3) | No |
| `GET /api/chats/:chatId/interactions` | Pending; payloads only where designated responder | Same | No | Same | No |
| `POST /api/chats/:chatId/interactions/:interactionId/resolve` | If designated responder | If designated responder | No | If designated responder | No |
| `DELETE /api/chat-agents/:agentId/grants/:grantId` | Yes | No | No | No | No |
| `POST /api/chat-agents/:agentId/memory/:itemId/forget` | Yes | No | No | No | No |
| `POST /api/chat-agents/:agentId/memory/:itemId/confirm` | Yes | No | No | No | No |
| `GET/POST/DELETE /api/chats/:chatId/bot-participants[/:agentId]` (M3) | Yes, with bot-owner consent | Read only | Read only | Read only | No |
| `PATCH /api/chat-agents/:agentId/routines/:routineId` (M2) | Yes | No | No | No | No |
| `WS /ws/computer/:computerId` (M4) | Yes | No | No | No | No |

## `POST /api/chat-agents/instantiate` (M1)

The browser first reads `GET /api/chat-agents/bot-recipes`. It returns at most 128
`{ recipeId, version, name, description, output }` entries. Instructions,
capabilities, and integration policy remain on the server. An unavailable catalog
does not turn a launch recipe into a freeform prompt handoff.

`GET /api/chats/:chatId/bot` returns `{ agentId: string | null }` for the
owner's direct bot Chat. `GET /api/chats/:chatId/bot-tasks` returns at most 20
open task summaries with allowlisted status and blocked reason fields. Both
validate the Chat ID before owner-scoped lookup. The shared Web Chat component
uses these reads to render bot identity and task state across Web Canvas and
Web Desktop.

Request:

```json
{ "clientRequestId": "req_...", "recipe": { "recipeId": "competitor-watching", "version": "string<=64" }, "name": "optional string<=80" }
```

- The server resolves the recipe version from the catalog and rejects unknown or retired versions.
- The server chooses the bot ID, chat ID, workspace, avatar seed, and runtime (`matrix_bot`, with the Provider V3 default access source).
- Idempotency is keyed by `(owner, clientRequestId)`.

Response `201` (or `200` on idempotent replay):

```json
{ "agent": { "id": "bot_...", "name": "Research Rabbit", "avatarSeed": "hex", "revision": 1, "status": "active|recovering" }, "chatId": "chat_...", "operation": "created|replayed" }
```

Errors:

- `409 conflict`: same `clientRequestId`, different payload
- `429 rate_limited`: owner at the 100-bot cap
- `503 unavailable`: store, database, or runtime missing

## `GET /api/chat-agents/:agentId/direct-chat` (M1)

Returns `{ "chatId": "chat_..." }` for the authenticated owner's active recipe bot and live direct binding, or `{ "chatId": null }` otherwise. The owner comes only from the request principal. Missing lookup infrastructure returns `503 unavailable`; invalid bot IDs return `400 invalid_request`. Reads are private and uncached.

All applicable Chat sidebars use this binding to open recipe bots, rather than attaching them to a new coding-agent draft. A lookup failure stays visible and never falls back to a different runtime. Recipe bot editors identify them by `recipeRef`, show Pi with automatic server routing, and omit coding model, Full access, and ordinary Agent recipe controls. PATCH selection changes are rejected for recipe bots; model routing stays under gateway policy.

## `GET /api/chat-agents/:agentId/authority` (M1)

This view is authoritative: it is derived from server state, never from model output.

```json
{
  "agentId": "bot_...", "revision": 7,
  "grants": [{ "grantId": "gr_...", "service": "gmail", "accountLabel": "test@...", "effects": ["read"], "audience": "direct", "expiresAt": null }],
  "connections": [{ "service": "google_calendar", "state": "not_connected|connected_not_granted|granted" }],
  "routines": [{ "routineId": "rt_...", "summary": "string<=200", "status": "active|paused", "nextFireAt": "iso" }],
  "pendingInteractions": [{ "interactionId": "in_...", "kind": "question|account_choice|connect_request|approval", "chatId": "chat_...", "expiresAt": "iso" }],
  "memory": { "items": [{ "itemId": "mem_...", "kind": "preference|fact|episode", "scope": "bot|chat", "content": "string<=4096", "source": { "messageId": "optional", "url": "optional", "at": "iso" }, "confirmed": true }], "nextCursor": "optional" }
}
```

- Account labels are the owner-visible labels already shown in Integrations. External account IDs are never returned.
- The group-visible subset (M3) omits private grants, private memory, and direct-chat interactions.

## `POST /api/chats/:chatId/interactions/:interactionId/resolve` (M1)

Request, a discriminated union on `kind` that must match the stored interaction kind:

```json
{ "kind": "question", "baseRevision": 3, "answer": "optional free text", "structuredAnswers": { "q1": ["Option label"] } }
{ "kind": "account_choice", "baseRevision": 3, "connectionId": "server-listed id" }
{ "kind": "connect_request", "baseRevision": 3, "action": "start|cancel|decline" }
{ "kind": "approval", "baseRevision": 3, "decision": "approve|deny" }
```

Rules:

- The claim is transactional: the interaction must be `pending`, unexpired, and at `baseRevision`, and the principal must be the designated responder.
- A resolution enqueues at most one continuation.
- `connect_request` + `start` depends on what the owner already has connected for the service:
  - one account: it is granted, and the interaction resolves with a continuation;
  - several accounts: the request resolves and an `account_choice` interaction follows;
  - none: a `bot_connect_requests` row is created (with an empty baseline) and the route returns `{ connectUrl }` from the existing broker `/connect`. The provider-hosted consent may open externally, and starting again reuses the same request.
- Connection requests are reconciled every 30 seconds by syncing and reading the account inventory. Exactly one new connection completes the request and continues the task; several ask which account to use.
- Completion is never inferred from a browser return. The next authorized chat read or reconcile tick checks the inventory.

Response `200`:

```json
{ "interaction": { "interactionId": "in_...", "status": "resolved", "revision": 4 }, "connectUrl": "optional https URL" }
```

Errors:

- `409 conflict`: stale revision or already resolved
- `404 not_found`
- `403 forbidden`: not the responder
- `410 expired` (allowlisted code `expired`)

## `GET /api/chats/:chatId/interactions` (M1)

Response `200 { "interactions": BotInteraction[] }`: pending, unexpired interactions in the chat, oldest first. The kind payload is included only for the designated responder.

A blocking question's answer continues the bot's waiting task. The answer is admitted as the responder's next message under `req_answer_<interactionId>`, so it runs at most once, and it is queued if the chat is busy. If that admission fails, the resolve route answers `503` after the answer is recorded. Repeating the identical request returns the same result and retries the continuation. A reply typed in the chat instead of the form also answers the task's open question.

## `DELETE /api/chat-agents/:agentId/grants/:grantId` (M1)

`bodyLimit` applies. Revocation sets `revoked_at`. Queued and running work rechecks before the next effect. Response `200 { "grantId": "...", "revokedAt": "iso" }`.

## Memory (M1)

- `POST .../memory/:itemId/forget` with `{ "baseRevision": 2 }`: sets `forgotten_at` and marks derived summaries for regeneration.
- `POST .../memory/:itemId/confirm` with `{ "baseRevision": 1 }`: confirms an externally sourced item so that it can be admitted into context.

Both return `200 { "itemId": "...", "revision": 3 }`.

## Bot participants (M3)

- `POST /api/chats/:chatId/bot-participants` with `{ "agentId": "bot_...", "clientRequestId": "req_..." }`. This requires the shared-chat manage permission plus bot-owner consent; the owner is the same person in the single-owner case.
- `DELETE /api/chats/:chatId/bot-participants/:agentId` stops future work. Existing messages keep their attribution.

## Routines (M2)

`PATCH /api/chat-agents/:agentId/routines/:routineId` with `{ "baseRevision": 2, "status": "active|paused|archived" }`. Creating a routine happens only through conversation: an approval-kind interaction whose payload carries schedule, timezone, delivery chat, and required effects.

## Computer stream (M4)

`WS /ws/computer/:computerId?token=...` requires an entry in the query-token allowlist (`packages/gateway/src/auth.ts`), an origin check, and a short-lived scoped token that is redacted in logs.

- Frames are bounded: 2 MiB per image and 256 queued frames per subscriber. Slow clients are disconnected.
- Control messages use a discriminated union (`takeover`, `return_control`, `input`) that carries the lease generation.
