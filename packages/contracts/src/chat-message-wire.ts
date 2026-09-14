import { z } from "zod/v4";
import type { CanonicalChatMessage } from "#canonical-chat";
import type { CanonicalChatTransportFrame } from "#canonical-chat-content";

/** Independent of SSE framing: protocol-2 clients shipped with message-v1 parsers. */
export const ChatMessageWireVersionSchema = z.enum(["1", "2"]).default("1");
export type ChatMessageWireVersion = z.infer<typeof ChatMessageWireVersionSchema>;

export function chatMessageVersionUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}messageVersion=2`;
}

function legacyMessage(message: CanonicalChatMessage): CanonicalChatMessage {
  const { actorId: _actorId, purpose: _purpose, ...legacy } = message;
  return legacy;
}

/** Project validated wire responses only; never change repository/outbox data. */
export function projectChatMessageResponse<T extends {
  message?: CanonicalChatMessage;
  messages?: CanonicalChatMessage[];
}>(response: T, version: ChatMessageWireVersion): T {
  if (version === "2") return response;
  return {
    ...response,
    ...(response.message ? { message: legacyMessage(response.message) } : {}),
    ...(response.messages ? { messages: response.messages.map(legacyMessage) } : {}),
  };
}

export function projectChatMessageFrame(
  frame: CanonicalChatTransportFrame,
  version: ChatMessageWireVersion,
): CanonicalChatTransportFrame {
  if (version === "2" || frame.type !== "chat.content") return frame;
  return { ...frame, content: {
    ...projectChatMessageResponse(frame.content, version),
    ...(frame.content.messageDelta ? { messageDelta: {
      ...frame.content.messageDelta,
      message: legacyMessage(frame.content.messageDelta.message),
    } } : {}),
  } };
}
