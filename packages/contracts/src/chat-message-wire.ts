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

function legacyMessage<T extends CanonicalChatMessage>(message: T) {
  const { actorId: _actorId, purpose: _purpose, ...legacy } = message;
  return legacy;
}

function legacyInputActivities(activities: CanonicalChatRunActivity[], version: ChatInputWireVersion): CanonicalChatRunActivity[] {
  return activities.flatMap<CanonicalChatRunActivity>(activity => {
    if (version === "1") {
      if (activity.type !== "input.requested") return [activity];
      const { asynchronous: _asynchronous, ...compatible } = activity;
      return [compatible];
    }
    if (activity.type === "input.submitted") return [];
    if (activity.type === "input.requested") {
      const { questions: _questions, safeDescription: _description, expiresAt: _expiresAt, asynchronous: _asynchronous, ...legacy } = activity;
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
  if (version === "2" && !response.activities) return response;
  return {
    ...response,
    ...(version === "1" && response.message ? { message: legacyMessage(response.message) } : {}),
    ...(version === "1" && response.messages ? { messages: response.messages.map(legacyMessage) } : {}),
    ...(response.activities ? { activities: legacyInputActivities(response.activities, inputVersion) } : {}),
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

/** Read-state support is independent of message/activity and SSE versions. */
export const ChatReadStateWireVersionSchema = z.enum(["0", "1"]).default("0");
export type ChatReadStateWireVersion = z.infer<typeof ChatReadStateWireVersionSchema>;

export function chatReadStateVersionUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}readStateVersion=1`;
}

/** Only project known Chat record positions; never traverse user message data. */
export function projectChatReadStateResponse<T>(response: T, version: ChatReadStateWireVersion): T {
  if (version === "1" || response === null || typeof response !== "object") return response;
  const value = response as Record<string, unknown>;
  const stripRecord = (record: unknown): unknown => {
    if (record === null || typeof record !== "object") return record;
    const { readState: _readState, ...legacy } = record as Record<string, unknown>;
    return legacy;
  };
  return {
    ...("chat" in value ? stripRecord(value) as object : value),
    ...("record" in value ? { record: stripRecord(value.record) } : {}),
    ...(Array.isArray(value.items) ? { items: value.items.map(stripRecord) } : {}),
  } as T;
}
