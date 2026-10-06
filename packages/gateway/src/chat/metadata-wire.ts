import { z } from "zod/v4";

export const ChatMetadataVersionSchema = z.enum(["0", "1", "2"]).default("0");

/** Only validated response envelopes enter here; never rewrite persisted records. */
export function projectChatMetadata<T>(value: T, version: "0" | "1" | "2"): T {
  if (version === "2") return value;
  function project(input: unknown, depth: number): unknown {
    if (depth > 4 || input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map((item) => project(item, depth + 1));
    const result = { ...input } as Record<string, unknown>;
    if (result.chat && typeof result.chat === "object") {
      const { conversationKind: _conversationKind, ...supported } = result.chat as Record<string, unknown>;
      if (version === "0") {
        const { titleVersion: _titleVersion, activityAt, ...chat } = supported;
        // Released clients sort updatedAt themselves. Give those clients stable activity.
        result.chat = { ...chat, ...(typeof activityAt === "string" ? { updatedAt: activityAt } : {}) };
      } else result.chat = supported;
    }
    for (const key of ["record", "items", "content"]) {
      if (key in result) result[key] = project(result[key], depth + 1);
    }
    return result;
  }
  return project(value, 0) as T;
}
