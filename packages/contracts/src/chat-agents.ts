import { z } from "zod/v4";
import { CanonicalChatModelSelectionSchema, CanonicalChatRequestIdSchema } from "#canonical-chat";
import { IsoTimestampSchema } from "#contract-primitives";
import { canonicalBoundedText, canonicalSafeLabel } from "#canonical-chat-primitives";
import { ChatAgentIdSchema } from "#chat-agent-context";

export const ChatAgentFieldsSchema = z.object({
  name: canonicalSafeLabel(80, 320),
  description: z.string().trim().max(400).default(""),
  instructions: canonicalBoundedText(8_000, 24 * 1024),
  selection: CanonicalChatModelSelectionSchema,
}).strict();
export const CreateChatAgentRequestSchema = ChatAgentFieldsSchema.extend({
  clientRequestId: CanonicalChatRequestIdSchema,
}).strict();
export const UpdateChatAgentRequestSchema = ChatAgentFieldsSchema.partial().extend({
  baseRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  archived: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 1, { message: "An update is required" });
export const ChatAgentSchema = ChatAgentFieldsSchema.extend({
  id: ChatAgentIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  archived: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();
export const ChatAgentListResponseSchema = z.object({
  enabled: z.boolean(),
  agents: z.array(ChatAgentSchema).max(100),
}).strict();
export type ChatAgent = z.infer<typeof ChatAgentSchema>;
export type CreateChatAgentRequest = z.infer<typeof CreateChatAgentRequestSchema>;
export type UpdateChatAgentRequest = z.infer<typeof UpdateChatAgentRequestSchema>;
export type ChatAgentListResponse = z.infer<typeof ChatAgentListResponseSchema>;
