import { z } from "zod/v4";
import type { CanonicalChatTransportFrame } from "#canonical-chat-content";

/** Unknown activities/context keys break released strict clients independently of message versions. */
export const ChatBotCreationWireVersionSchema = z.enum(["0", "1"]).default("0");
export type ChatBotCreationWireVersion = z.infer<typeof ChatBotCreationWireVersionSchema>;
export function chatBotCreationVersionUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}botCreationVersion=1`;
}

/** Project only known envelope positions, never arbitrary user text/tool output. */
export function projectChatBotCreationResponse<T>(value: T, version: ChatBotCreationWireVersion): T {
  if (version === "1") return value;
  function project(input: unknown, depth: number): unknown {
    if (depth > 5 || input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(item => project(item, depth + 1));
    const result = { ...input } as Record<string, unknown>;
    if (result.context && typeof result.context === "object") {
      const legacy = { ...result.context } as Record<string, unknown>;
      delete legacy.botCreation;
      result.context = legacy;
    }
    if (Array.isArray(result.activities)) result.activities = result.activities.filter(activity =>
      activity === null || typeof activity !== "object" || (activity as { type?: unknown }).type !== "bot.draft.proposed");
    for (const key of ["content", "run", "runs", "queuedTurn", "queuedTurns"]) {
      if (key in result) result[key] = project(result[key], depth + 1);
    }
    return result;
  }
  return project(value, 0) as T;
}
export function projectChatBotCreationFrame(frame: CanonicalChatTransportFrame, version: ChatBotCreationWireVersion): CanonicalChatTransportFrame {
  return frame.type === "chat.content" ? projectChatBotCreationResponse(frame, version) : frame;
}
