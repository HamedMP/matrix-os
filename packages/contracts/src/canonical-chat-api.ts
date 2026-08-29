import { z } from "zod/v4";
import {
  CanonicalChatMessagePartSchema,
  CanonicalChatMessageSchema,
  CanonicalChatModelSelectionSchema,
  CanonicalChatRequestIdSchema,
  CanonicalChatRunActivitySchema,
  CanonicalChatRunIdSchema,
  CanonicalChatRunSchema,
  CanonicalChatSchema,
  CanonicalChatTurnSchema,
} from "#canonical-chat";
import {
  CanonicalChatExecutionRootRefSchema,
  canonicalReferenceId,
} from "#canonical-chat-primitives";
import {
  CanonicalChatActiveRunProjectionSchema,
  CanonicalChatProviderBindingSchema,
} from "#canonical-chat-surface";
import { IsoTimestampSchema } from "#contract-primitives";

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

export const CanonicalUpdateChatProjectRequestSchema = z.object({
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  projectId: canonicalReferenceId(160).nullable(),
}).strict();

export const CanonicalUpdateChatUserStateRequestSchema = z.object({
  pinned: z.boolean(),
}).strict();

const USER_INPUT_PART_TYPES = new Set([
  "text",
  "attachment_reference",
  "invocation_reference",
  "resource_reference",
]);

export const CanonicalChatUserInputPartSchema = CanonicalChatMessagePartSchema
  .refine((part) => USER_INPUT_PART_TYPES.has(part.type), {
    message: "Part is not accepted as user input",
  });

export const CanonicalCreateChatTurnRequestSchema = z.object({
  clientRequestId: CanonicalChatRequestIdSchema,
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  parts: z.array(CanonicalChatUserInputPartSchema).min(1).max(64),
  selection: CanonicalChatModelSelectionSchema,
  interactionMode: canonicalReferenceId(80),
  permissionMode: canonicalReferenceId(80),
  executionRoot: CanonicalChatExecutionRootRefSchema.optional(),
}).strict();

export const CanonicalCancelChatRunRequestSchema = z.object({
  clientRequestId: CanonicalChatRequestIdSchema,
}).strict();

export const CanonicalRetryChatTurnRequestSchema = z.object({
  clientRequestId: CanonicalChatRequestIdSchema,
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const CanonicalAcknowledgeChatCompletionRequestSchema = z.object({}).strict();

export const CanonicalChatLatestSuccessfulCompletionSchema = z.object({
  runId: CanonicalChatRunIdSchema,
  completedAt: IsoTimestampSchema,
  unacknowledged: z.boolean(),
}).strict();

export const CanonicalChatRecordSchema = z.object({
  chat: CanonicalChatSchema,
  projectId: canonicalReferenceId(160).optional(),
  providerBinding: CanonicalChatProviderBindingSchema.optional(),
  activeRun: CanonicalChatActiveRunProjectionSchema.optional(),
  latestSuccessfulCompletion: CanonicalChatLatestSuccessfulCompletionSchema.optional(),
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
  terminalSessionIds: z.array(canonicalReferenceId(128)).max(100).optional(),
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

export const CanonicalChatTurnAdmissionResponseSchema = z.object({
  record: CanonicalChatRecordSchema,
  message: CanonicalChatMessageSchema,
  turn: CanonicalChatTurnSchema,
  run: CanonicalChatRunSchema,
  admission: z.enum(["accepted", "already_accepted"]),
}).strict().superRefine((response, ctx) => {
  const chatId = response.record.chat.id;
  if (response.message.chatId !== chatId
    || response.turn.chatId !== chatId
    || response.run.chatId !== chatId) {
    ctx.addIssue({ code: "custom", message: "Admission Chat mismatch" });
  }
  if (response.message.turnId !== response.turn.id
    || response.turn.inputMessageId !== response.message.id
    || response.run.turnId !== response.turn.id) {
    ctx.addIssue({ code: "custom", message: "Admission relationship mismatch" });
  }
});

export const CanonicalChatRunCancellationResponseSchema = z.object({
  run: CanonicalChatRunSchema,
  cancellation: z.enum(["aborted", "already_terminal"]),
}).strict();

export const CanonicalChatRunAdmissionResponseSchema = z.object({
  record: CanonicalChatRecordSchema,
  turn: CanonicalChatTurnSchema,
  run: CanonicalChatRunSchema,
  admission: z.enum(["accepted", "already_accepted"]),
}).strict().superRefine((response, ctx) => {
  const chatId = response.record.chat.id;
  if (response.turn.chatId !== chatId || response.run.chatId !== chatId
    || response.run.turnId !== response.turn.id) {
    ctx.addIssue({ code: "custom", message: "Run admission relationship mismatch" });
  }
});

export type CanonicalCreateChatRequest = z.infer<typeof CanonicalCreateChatRequestSchema>;
export type CanonicalUpdateChatProjectRequest = z.infer<typeof CanonicalUpdateChatProjectRequestSchema>;
export type CanonicalUpdateChatUserStateRequest = z.infer<typeof CanonicalUpdateChatUserStateRequestSchema>;
export type CanonicalCreateChatTurnRequest = z.infer<typeof CanonicalCreateChatTurnRequestSchema>;
export type CanonicalCancelChatRunRequest = z.infer<typeof CanonicalCancelChatRunRequestSchema>;
export type CanonicalRetryChatTurnRequest = z.infer<typeof CanonicalRetryChatTurnRequestSchema>;
export type CanonicalAcknowledgeChatCompletionRequest = z.infer<
  typeof CanonicalAcknowledgeChatCompletionRequestSchema
>;
export type CanonicalChatLatestSuccessfulCompletion = z.infer<
  typeof CanonicalChatLatestSuccessfulCompletionSchema
>;
export type CanonicalChatRecord = z.infer<typeof CanonicalChatRecordSchema>;
export type CanonicalChatListResponse = z.infer<typeof CanonicalChatListResponseSchema>;
export type CanonicalChatDetailResponse = z.infer<typeof CanonicalChatDetailResponseSchema>;
export type CanonicalChatTurnAdmissionResponse = z.infer<typeof CanonicalChatTurnAdmissionResponseSchema>;
export type CanonicalChatRunCancellationResponse = z.infer<typeof CanonicalChatRunCancellationResponseSchema>;
export type CanonicalChatRunAdmissionResponse = z.infer<typeof CanonicalChatRunAdmissionResponseSchema>;
