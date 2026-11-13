import { z } from "zod/v4";
import { canonicalReferenceId } from "#canonical-chat-primitives";

export const CanonicalLivePermissionModeSchema = z.enum(["supervised", "full_access"]);
export type CanonicalLivePermissionMode = z.infer<typeof CanonicalLivePermissionModeSchema>;
export const CanonicalSetChatPermissionModeRequestSchema = z.object({
  clientRequestId: canonicalReferenceId(128), permissionMode: CanonicalLivePermissionModeSchema,
}).strict();
export type CanonicalSetChatPermissionModeRequest = z.infer<typeof CanonicalSetChatPermissionModeRequestSchema>;
export const CanonicalSetChatPermissionModeResponseSchema = z.object({
  chatId: canonicalReferenceId(128), runId: canonicalReferenceId(128),
  permissionMode: CanonicalLivePermissionModeSchema, submission: z.enum(["accepted", "already_applied"]),
}).strict();
export type CanonicalSetChatPermissionModeResponse = z.infer<typeof CanonicalSetChatPermissionModeResponseSchema>;

/** Strict released clients do not recognize permission-change activities. */
export const ChatPermissionModeWireVersionSchema = z.enum(["0", "1"]).default("0");
export function projectChatPermissionModeResponse<T>(value: T, version: "0" | "1"): T {
  if (version === "1" || value === null || typeof value !== "object") return value;
  const response = value as Record<string, unknown>;
  if (response.type === "chat.content" && response.content) return { ...response,
    content: projectChatPermissionModeResponse(response.content, version) } as T;
  if (!Array.isArray(response.activities)) return value;
  return { ...response, activities: response.activities.filter(activity => !activity || typeof activity !== "object"
    || (activity as { type?: unknown }).type !== "run.permission_mode") } as T;
}
