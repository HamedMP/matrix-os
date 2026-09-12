import { z } from "zod/v4";
import type { CanonicalChatMessage, CanonicalChatRunActivity } from "#canonical-chat";
import type { CanonicalChatTransportFrame } from "#canonical-chat-content";

/** Independent of SSE framing: protocol-2 clients shipped with message-v1 parsers. */
export const ChatMessageWireVersionSchema = z.enum(["1", "2"]).default("1");
export type ChatMessageWireVersion = z.infer<typeof ChatMessageWireVersionSchema>;
/** Older clients reject unknown activity fields, even with message v2 enabled. */
export const ChatInputWireVersionSchema = z.enum(["0", "1"]).default("0");
export type ChatInputWireVersion = z.infer<typeof ChatInputWireVersionSchema>;

export function chatMessageVersionUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}messageVersion=2&inputVersion=1`;
}

function legacyMessage(message: CanonicalChatMessage): CanonicalChatMessage {
  const { actorId: _actorId, purpose: _purpose, ...legacy } = message;
  return legacy;
}

function legacyInputActivities(activities: CanonicalChatRunActivity[]): CanonicalChatRunActivity[] {
  return activities.flatMap<CanonicalChatRunActivity>(activity => {
    if (activity.type === "input.submitted") return [];
    if (activity.type === "input.requested") {
      const { questions: _questions, safeDescription: _description, expiresAt: _expiresAt, ...legacy } = activity;
      return [legacy];
    }
    if (activity.type === "input.resolved") {
      const { reason: _reason, ...legacy } = activity;
      return [legacy];
    }
    return [activity];
  });
}

/** Project validated wire responses only; never change repository/outbox data. */
export function projectChatMessageResponse<T extends {
  message?: CanonicalChatMessage;
  messages?: CanonicalChatMessage[];
  activities?: CanonicalChatRunActivity[];
}>(response: T, version: ChatMessageWireVersion, inputVersion: ChatInputWireVersion = "0"): T {
  if (version === "2" && (inputVersion === "1" || !response.activities)) return response;
  return {
    ...response,
    ...(version === "1" && response.message ? { message: legacyMessage(response.message) } : {}),
    ...(version === "1" && response.messages ? { messages: response.messages.map(legacyMessage) } : {}),
    ...(inputVersion === "0" && response.activities ? { activities: legacyInputActivities(response.activities) } : {}),
  };
}

export function projectChatMessageFrame(
  frame: CanonicalChatTransportFrame,
  version: ChatMessageWireVersion,
  inputVersion: ChatInputWireVersion = "0",
): CanonicalChatTransportFrame {
  if (frame.type !== "chat.content") return frame;
  return { ...frame, content: {
    ...projectChatMessageResponse(frame.content, version, inputVersion),
    ...(version === "1" && frame.content.messageDelta ? { messageDelta: {
      ...frame.content.messageDelta,
      message: legacyMessage(frame.content.messageDelta.message),
    } } : {}),
  } };
}
