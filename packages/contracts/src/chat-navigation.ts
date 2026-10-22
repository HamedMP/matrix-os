import { z } from "zod/v4";
import { CanonicalChatSchema } from "#canonical-chat";
import { ChatAgentIdSchema } from "#chat-agent-context";
import { canonicalReferenceId } from "#canonical-chat-primitives";
import { CanonicalChatActiveRunProjectionSchema, CanonicalChatProviderBindingSchema } from "#canonical-chat-surface";
import { CanonicalChatLatestSuccessfulCompletionSchema, CanonicalChatReadStateSchema, CanonicalChatImportSourceSchema } from "#canonical-chat-api";

export const CHAT_NAVIGATION_MAX_ITEMS = 1000;
export const CHAT_NAVIGATION_MAX_BYTES = 2 * 1024 * 1024;
/** This is a display projection, never a full Chat or an authorization token. */
export const CanonicalChatNavigationItemSchema = z.object({
  chat: CanonicalChatSchema.pick({ id: true, title: true, titleVersion: true, activityAt: true,
    lifecycle: true, attention: true, revision: true, messageCount: true, userState: true,
    createdAt: true, updatedAt: true }),
  importSource: CanonicalChatImportSourceSchema.optional(),
  projectId: canonicalReferenceId(160).optional(),
  providerBinding: CanonicalChatProviderBindingSchema.pick({ driverKind: true }).optional(),
  activeRun: CanonicalChatActiveRunProjectionSchema.optional(),
  latestSuccessfulCompletion: CanonicalChatLatestSuccessfulCompletionSchema.optional(),
  readState: CanonicalChatReadStateSchema,
  classification: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ordinary") }).strict(),
    z.object({ kind: z.literal("bot"), agentId: ChatAgentIdSchema }).strict(),
  ]),
  persistence: z.enum(["personal", "membership"]),
}).strict();
export const CanonicalChatNavigationResponseSchema = z.object({
  version: z.literal(1),
  items: z.array(CanonicalChatNavigationItemSchema).max(CHAT_NAVIGATION_MAX_ITEMS),
  truncated: z.boolean(),
}).strict().superRefine((snapshot, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > CHAT_NAVIGATION_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: "Navigation snapshot exceeds its byte budget" });
  }
});
export const CanonicalChatNavigationQuerySchema = z.object({
  version: z.coerce.number().pipe(z.literal(1)).default(1),
  limit: z.coerce.number().int().min(1).max(CHAT_NAVIGATION_MAX_ITEMS).default(CHAT_NAVIGATION_MAX_ITEMS),
  lifecycle: z.enum(["active", "archived"]).optional(),
}).strict();
export type CanonicalChatNavigationItem = z.infer<typeof CanonicalChatNavigationItemSchema>;
export type CanonicalChatNavigationResponse = z.infer<typeof CanonicalChatNavigationResponseSchema>;
export type CanonicalChatNavigationQuery = z.infer<typeof CanonicalChatNavigationQuerySchema>;
