import { z } from "zod/v4";
import type { CanonicalChatOutboxEventType } from "#canonical-chat-api";

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
