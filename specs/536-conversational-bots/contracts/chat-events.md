# Canonical Chat Event Additions

These additions extend the closed event enum in `packages/contracts/src/canonical-chat-api.ts` and the outbox types. Every event is published through the existing transactional outbox after commit, with the existing WebSocket (`/ws/chats/events`) and HTTP (`/api/chats/events`) delivery.

Stream events carry only `{ cursor, chatId, revision, eventType, createdAt }`, and clients refetch details through authorized reads. The payload column below describes what a bot-aware client refetches, not stream fields.

**Compatibility.** Released desktop and mobile clients validate `eventType` strictly. New types reach a client only when it sends event wire version `1` (`ChatEventWireVersionSchema`, `packages/contracts/src/chat-event-wire.ts`). Clients on version `0` (the default) receive `chat.updated` for every bot event type via `projectChatEventTypeForWire`.

**Chat binding.** Events without a natural chat use the bot's direct chat ID.

| Event | Payload | Emitted when |
|---|---|---|
| `bot.created` | `{ agentId, chatId, revision }` | Instantiation reaches `active` |
| `interaction.requested` | `{ interactionId, chatId, agentId, kind, blocking, expiresAt, revision }` plus the kind payload for the designated responder only | A bot creates an interaction |
| `interaction.resolved` | `{ interactionId, chatId, status, revision }` | Resolve, cancel, or expiry |
| `bot.task.updated` | `{ taskId, chatId, agentId, status, blockedReason?, revision }` | Any task status change, including `waiting_capacity` |
| `bot.authority.changed` | `{ agentId, revision }` | Grant, routine, memory, or connection changes for that bot |
| `bot.memory.remembered` | `{ agentId, chatId, itemId, kind, confirmed }` | A memory item is written; rendered as the visible remembered-item part |
| `bot.participant.changed` (M3) | `{ chatId, agentId, change: "added" \| "removed" }` | Participant changes |
| `bot.handoff.updated` (M3) | `{ handoffId, parentTaskId, fromAgentId, toAgentId, status }` | Handoff changes |
| `computer.session.updated` (M4) | `{ computerId, controller: "bot" \| "person", leaseGeneration }` | Lease or takeover changes |

Rules:

- Payloads carry IDs and allowlisted state only. Content is fetched through authorized reads, so events never leak private memory or grant details to group subscribers.
- Group subscribers receive only events for their shared chat. `bot.authority.changed` goes to the bot owner only.
- Delivery keeps the existing caps: 256 queued events per subscriber, 64 subscribers per owner, slow-client disconnection, and cursor resume. A failing sender is evicted after the broadcast loop.
