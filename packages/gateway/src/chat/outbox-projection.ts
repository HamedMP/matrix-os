import type { ChatOutboxEvent } from './records.js';

/** Private server composition only; no route or client may choose this mode. */
export type ChatContentProjectionMode = 'metadata-only';

/** Copy scalar notification fields without accessing arbitrary payload properties. */
export function metadataOnlyOutboxEvent(event: ChatOutboxEvent): ChatOutboxEvent {
  return { cursor: event.cursor, chatId: event.chatId, revision: event.revision,
    eventType: event.eventType, createdAt: event.createdAt, payload: {} };
}
