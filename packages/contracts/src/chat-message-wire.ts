import { z } from "zod/v4";
import type { CanonicalChatMessage, CanonicalChatRunActivity } from "#canonical-chat";
import type { CanonicalChatTransportFrame } from "#canonical-chat-content";
import { projectLegacyAssistantMessage } from "./chat-legacy-assistant-text.js";
export { projectLegacyAssistantMessage, projectLegacyAssistantTextParts } from "./chat-legacy-assistant-text.js";
import { canonicalSafeLabel } from "#canonical-chat-primitives";

/** Expanded stored assistant text requires independent explicit client support. */
export const ChatAssistantTextWireVersionSchema = z.enum(["0", "1"]).default("0");
export type ChatAssistantTextWireVersion = z.infer<typeof ChatAssistantTextWireVersionSchema>;

/** Independent of SSE framing: protocol-2 clients shipped with message-v1 parsers. */
export const ChatMessageWireVersionSchema = z.enum(["1", "2"]).default("1");
export type ChatMessageWireVersion = z.infer<typeof ChatMessageWireVersionSchema>;
/** Older clients reject unknown activity fields, even with message v2 enabled. */
export const ChatInputWireVersionSchema = z.enum(["0", "1"]).default("0");
export type ChatInputWireVersion = z.infer<typeof ChatInputWireVersionSchema>;
/** Complete owner commands need a client that accepts private paths in previews. */
export const ChatCommandPreviewWireVersionSchema = z.enum(["0", "1"]).default("0");
export type ChatCommandPreviewWireVersion = z.infer<typeof ChatCommandPreviewWireVersionSchema>;
const LegacyToolPreviewSchema = canonicalSafeLabel(1_000, 4_000);

export function chatMessageVersionUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}messageVersion=2&inputVersion=1&commandPreviewVersion=1&assistantTextVersion=1`;
}

function commandPreviewActivities(activities: CanonicalChatRunActivity[], version: ChatCommandPreviewWireVersion): CanonicalChatRunActivity[] {
  return activities.map(activity => {
    if (activity.type !== "agent.activity") return activity;
    const { protectedPreview: _protectedPreview, ...visible } = activity;
    if (version === "0" && activity.previewKind === "command" && activity.preview
      && !LegacyToolPreviewSchema.safeParse(activity.preview).success) {
      const { preview: _preview, previewKind: _kind, ...legacy } = visible;
      return legacy;
    }
    return visible;
  });
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
}>(response: T, version: ChatMessageWireVersion, inputVersion: ChatInputWireVersion = "0", commandPreviewVersion: ChatCommandPreviewWireVersion = "0", assistantTextVersion: ChatAssistantTextWireVersion = "0"): T {
  if (version === "2" && !response.activities && assistantTextVersion === "1") return response;
  const message = (value: CanonicalChatMessage) => {
    const projected = version === "1" ? legacyMessage(value) : value;
    return assistantTextVersion === "1" ? projected : projectLegacyAssistantMessage(projected);
  };
  return {
    ...response,
    ...(response.message ? { message: message(response.message) } : {}),
    ...(response.messages ? { messages: response.messages.map(message) } : {}),
    ...(response.activities ? { activities: commandPreviewActivities(legacyInputActivities(response.activities, inputVersion), commandPreviewVersion) } : {}),
  };
}

export function projectChatMessageFrame(
  frame: CanonicalChatTransportFrame,
  version: ChatMessageWireVersion,
  inputVersion: ChatInputWireVersion = "0",
  commandPreviewVersion: ChatCommandPreviewWireVersion = "0",
  assistantTextVersion: ChatAssistantTextWireVersion = "0",
): CanonicalChatTransportFrame {
  if (frame.type !== "chat.content") return frame;
  // Legacy snapshots may regroup parts: raw delta indices would no longer match.
  if (assistantTextVersion === "0") return { type: "chat.event", event: frame.event };
  return { ...frame, content: {
    ...projectChatMessageResponse(frame.content, version, inputVersion, commandPreviewVersion, assistantTextVersion),
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
