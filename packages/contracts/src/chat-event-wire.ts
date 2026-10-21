import { z } from "zod/v4";
import type { CanonicalChatOutboxEventType } from "#canonical-chat-api";
import type { CanonicalChatTransportFrame } from "#canonical-chat-content";

/**
 * Stream clients validate event types strictly, and released desktop and
 * mobile builds reject unknown ones. Bot event types reach a client only when
 * it opts into event wire v1; older clients see `chat.updated` and refetch.
 */
export const ChatEventWireVersionSchema = z.enum(["0", "1"]).default("0");
export type ChatEventWireVersion = z.infer<typeof ChatEventWireVersionSchema>;

const EVENT_WIRE_V1_TYPES: ReadonlySet<CanonicalChatOutboxEventType> = new Set<CanonicalChatOutboxEventType>([
  "bot.created",
  "interaction.requested",
  "interaction.resolved",
  "bot.task.updated",
  "bot.authority.changed",
  "bot.memory.remembered",
]);

export function projectChatEventTypeForWire(
  eventType: CanonicalChatOutboxEventType,
  version: ChatEventWireVersion,
): CanonicalChatOutboxEventType {
  if (version === "1" || !EVENT_WIRE_V1_TYPES.has(eventType)) return eventType;
  return "chat.updated";
}

/** Applied to every live and replayed frame by both event delivery routes. */
export function projectChatEventFrame(
  frame: CanonicalChatTransportFrame,
  version: ChatEventWireVersion,
): CanonicalChatTransportFrame {
  if (frame.type !== "chat.event" && frame.type !== "chat.content") return frame;
  const eventType = projectChatEventTypeForWire(frame.event.eventType, version);
  if (eventType === frame.event.eventType) return frame;
  return { ...frame, event: { ...frame.event, eventType } };
}

export function chatEventVersionUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}eventVersion=1`;
}
