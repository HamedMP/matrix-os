import type { AppserviceEvent, MessagingNetworkSlug } from "./schemas.js";

export interface NormalizedAppserviceEvent {
  ownerId: string;
  networkSlug: MessagingNetworkSlug;
  accountId: string;
  roomId: string;
  eventId: string;
  externalEventId?: string;
  content: AppserviceEvent["content"];
  occurredAt: string;
}

export function normalizeAppserviceEvent(input: {
  ownerId: string;
  networkSlug: MessagingNetworkSlug;
  event: AppserviceEvent;
}): NormalizedAppserviceEvent {
  return {
    ownerId: input.ownerId,
    networkSlug: input.networkSlug,
    accountId: input.event.accountId,
    roomId: input.event.roomId,
    eventId: input.event.eventId,
    externalEventId: input.event.externalEventId,
    content: input.event.content,
    occurredAt: input.event.occurredAt,
  };
}
