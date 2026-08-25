import { z } from "zod/v4";
import {
  CanonicalChatMessageSchema,
  CanonicalChatModelSelectionSchema,
  CanonicalChatRequestIdSchema,
  CanonicalChatRunActivitySchema,
  CanonicalChatRunSchema,
  CanonicalChatSchema,
  CanonicalChatTurnSchema,
} from "#canonical-chat";
import { canonicalReferenceId } from "#canonical-chat-primitives";
import {
  CanonicalChatActiveRunProjectionSchema,
  CanonicalChatProviderBindingSchema,
} from "#canonical-chat-surface";

export const CanonicalChatApiCursorSchema = z.string()
  .min(9)
  .max(512)
  .regex(/^chatcur_[A-Za-z0-9_-]+$/);

export const CanonicalCreateChatRequestSchema = z.object({
  clientRequestId: CanonicalChatRequestIdSchema,
  title: CanonicalChatSchema.shape.title.optional(),
  projectId: canonicalReferenceId(160).optional(),
  currentSelection: CanonicalChatModelSelectionSchema.optional(),
}).strict();

export const CanonicalChatRecordSchema = z.object({
  chat: CanonicalChatSchema,
  projectId: canonicalReferenceId(160).optional(),
  providerBinding: CanonicalChatProviderBindingSchema.optional(),
  activeRun: CanonicalChatActiveRunProjectionSchema.optional(),
}).strict().superRefine((record, ctx) => {
  if (record.providerBinding !== undefined
    && record.chat.currentSelection?.instanceId !== record.providerBinding.instanceId) {
    ctx.addIssue({
      code: "custom",
      path: ["chat", "currentSelection", "instanceId"],
      message: "Bound Chat selection must use its immutable Provider Instance",
    });
  }
});

export const CanonicalChatListResponseSchema = z.object({
  items: z.array(CanonicalChatRecordSchema).max(100),
  nextCursor: CanonicalChatApiCursorSchema.optional(),
}).strict();

export const CanonicalChatDetailResponseSchema = z.object({
  record: CanonicalChatRecordSchema,
  messages: z.array(CanonicalChatMessageSchema).max(200),
  turns: z.array(CanonicalChatTurnSchema).max(100),
  runs: z.array(CanonicalChatRunSchema).max(100),
  activities: z.array(CanonicalChatRunActivitySchema).max(500),
  nextCursor: CanonicalChatApiCursorSchema.optional(),
}).strict().superRefine((detail, ctx) => {
  const chatId = detail.record.chat.id;
  for (const [key, values] of [
    ["messages", detail.messages],
    ["turns", detail.turns],
    ["runs", detail.runs],
    ["activities", detail.activities],
  ] as const) {
    values.forEach((value, index) => {
      if (value.chatId !== chatId) {
        ctx.addIssue({ code: "custom", path: [key, index, "chatId"], message: "Chat mismatch" });
      }
    });
  }
});

export type CanonicalCreateChatRequest = z.infer<typeof CanonicalCreateChatRequestSchema>;
export type CanonicalChatRecord = z.infer<typeof CanonicalChatRecordSchema>;
export type CanonicalChatListResponse = z.infer<typeof CanonicalChatListResponseSchema>;
export type CanonicalChatDetailResponse = z.infer<typeof CanonicalChatDetailResponseSchema>;
