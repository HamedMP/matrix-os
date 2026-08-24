import { z } from "zod/v4";
import { boundedDisplayText, referenceId } from "#legacy-contract-primitives";

const ProjectIdSchema = referenceId(160);

export const KernelConversationIdSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/, "Invalid conversation id")
  .refine((value) => !value.includes(".."), { message: "Invalid conversation id" });

const KernelConversationContextLabelSchema = (maxChars: number) => boundedDisplayText(maxChars)
  .refine(
    (value) => !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(value),
    { message: "Context labels cannot be absolute paths" },
  );

export const KernelConversationContextUpdateSchema = z.object({
  projectId: ProjectIdSchema.nullable(),
}).strict();

export const KernelConversationContextProjectionSchema = z.object({
  projectId: ProjectIdSchema,
  projectName: KernelConversationContextLabelSchema(160),
  projectKind: z.enum(["scratch", "github", "folder"]),
  repositoryLabel: KernelConversationContextLabelSchema(200).optional(),
  status: z.enum(["ready", "unavailable"]),
}).strict();

export const KernelConversationSummarySchema = z.object({
  id: KernelConversationIdSchema,
  preview: z.string().max(32_000),
  messageCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  context: KernelConversationContextProjectionSchema.optional(),
}).strict();

export const KernelConversationHistoryQuerySchema = z.object({
  cursor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
}).strict();

export const KernelConversationToolDisplaySchema = z.object({
  kind: z.enum(["command", "file", "search", "text"]),
  preview: boundedDisplayText(160),
}).strict();

export const KernelConversationHistoryMessageSchema = z.object({
  index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(32_000),
  contentTruncated: z.boolean(),
  timestamp: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  tool: z.string().min(1).max(128).optional(),
  toolDisplay: KernelConversationToolDisplaySchema.optional(),
}).strict();

export const KernelConversationHistoryResponseSchema = z.object({
  id: KernelConversationIdSchema,
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  context: KernelConversationContextProjectionSchema.optional(),
  totalCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  messages: z.array(KernelConversationHistoryMessageSchema).max(50),
  hasMore: z.boolean(),
  nextCursor: z.string()
    .min(1)
    .max(16)
    .regex(/^[1-9][0-9]*$/)
    .refine((value) => Number.isSafeInteger(Number(value)), { message: "Invalid history cursor" })
    .optional(),
  limit: z.number().int().min(1).max(50),
}).strict();

export const KernelConversationDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();

export const KernelConversationMutationErrorCodeSchema = z.enum([
  "invalid_conversation_id",
  "invalid_conversation_context",
  "conversation_not_found",
  "conversation_busy",
  "conversation_delete_unavailable",
  "project_unavailable",
  "project_context_conflict",
  "conversation_context_unavailable",
]);

export type KernelConversationId = z.infer<typeof KernelConversationIdSchema>;
export type KernelConversationContextUpdate = z.infer<typeof KernelConversationContextUpdateSchema>;
export type KernelConversationContextProjection = z.infer<typeof KernelConversationContextProjectionSchema>;
export type KernelConversationSummary = z.infer<typeof KernelConversationSummarySchema>;
export type KernelConversationHistoryQuery = z.infer<typeof KernelConversationHistoryQuerySchema>;
export type KernelConversationHistoryMessage = z.infer<typeof KernelConversationHistoryMessageSchema>;
export type KernelConversationHistoryResponse = z.infer<typeof KernelConversationHistoryResponseSchema>;
export type KernelConversationToolDisplay = z.infer<typeof KernelConversationToolDisplaySchema>;
export type KernelConversationDeleteResponse = z.infer<typeof KernelConversationDeleteResponseSchema>;
export type KernelConversationMutationErrorCode = z.infer<typeof KernelConversationMutationErrorCodeSchema>;
