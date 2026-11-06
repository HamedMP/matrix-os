import { z } from "zod/v4";
import { UserInputQuestionListSchema } from "#agent-thread-contracts";
import { CanonicalChatIdSchema } from "#canonical-chat";
import { CanonicalSubmitChatInputRequestSchema } from "#canonical-chat-api";
import { canonicalBoundedText, canonicalEncodedByteLength, canonicalReferenceId } from "#canonical-chat-primitives";
import { IsoTimestampSchema } from "#contract-primitives";
import { BotAccountLabelSchema, BotAudienceSchema, BotEffectListSchema } from "#bots/grants";
import {
  BotBaseRevisionSchema,
  BotConnectionIdSchema,
  BotConnectRequestIdSchema,
  BotIdSchema,
  BotIntegrationServiceSchema,
  BotInteractionIdSchema,
  BotRevisionSchema,
  BotTaskIdSchema,
} from "#bots/ids";
import { BotHttpsUrlSchema } from "#bots/memory";

const MAX_PAYLOAD_BYTES = 16 * 1024;
export const BOT_ROUTINE_APPROVAL_PREVIEW_LIMIT = 32 * 1024;
/** Only the exact routine envelope needs room for a 4096-character escaped prompt. */
export function botInteractionPayloadByteLimit(payload: { kind?: unknown; tool?: unknown }): number {
  return payload.kind === "approval" && payload.tool === "routine.activate" ? 24 * 1024 : MAX_PAYLOAD_BYTES;
}

export const BotInteractionKindSchema = z.enum(["question", "account_choice", "connect_request", "approval"]);
export const BotInteractionStatusSchema = z.enum(["pending", "resolved", "expired", "cancelled"]);

const QuestionPayloadSchema = z.object({
  kind: z.literal("question"),
  questions: UserInputQuestionListSchema,
}).strict();

const AccountChoicePayloadSchema = z.object({
  kind: z.literal("account_choice"),
  service: BotIntegrationServiceSchema,
  /** Disclosed by the server before granting account access; absent in older stored interactions. */
  access: BotEffectListSchema.optional(),
  options: z.array(z.object({
    connectionId: BotConnectionIdSchema,
    label: BotAccountLabelSchema,
  }).strict()).min(1).max(10)
    .refine((options) => new Set(options.map((option) => option.connectionId)).size === options.length, {
      message: "Account options must be unique",
    }),
}).strict();

const ConnectRequestPayloadSchema = z.object({
  kind: z.literal("connect_request"),
  service: BotIntegrationServiceSchema,
  access: BotEffectListSchema,
  benefit: canonicalBoundedText(280, 1_120),
  connectRequestId: BotConnectRequestIdSchema,
}).strict();

/** The exact effect a person approves; any change to it invalidates the approval. */
const ApprovalPayloadSchema = z.object({
  kind: z.literal("approval"),
  tool: canonicalReferenceId(128),
  argsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  account: z.object({ service: BotIntegrationServiceSchema, label: BotAccountLabelSchema }).strict().optional(),
  audience: BotAudienceSchema,
  preview: canonicalBoundedText(BOT_ROUTINE_APPROVAL_PREVIEW_LIMIT, BOT_ROUTINE_APPROVAL_PREVIEW_LIMIT),
  policyRevision: BotRevisionSchema,
}).strict().refine(payload => payload.tool === "routine.activate"
  || payload.preview.length <= 4096 && new TextEncoder().encode(payload.preview).byteLength <= 16 * 1024,
  { message: "Approval preview is too large" });

export const BotInteractionPayloadSchema = z.discriminatedUnion("kind", [
  QuestionPayloadSchema,
  AccountChoicePayloadSchema,
  ConnectRequestPayloadSchema,
  ApprovalPayloadSchema,
]).refine((payload) => canonicalEncodedByteLength(payload) <= botInteractionPayloadByteLimit(payload), { message: "Interaction payload is too large" });

/** Responder-facing projection. The payload is present only for the designated responder. */
export const BotInteractionSchema = z.object({
  interactionId: BotInteractionIdSchema,
  chatId: CanonicalChatIdSchema,
  agentId: BotIdSchema,
  taskId: BotTaskIdSchema,
  kind: BotInteractionKindSchema,
  blocking: z.boolean(),
  status: BotInteractionStatusSchema,
  expiresAt: IsoTimestampSchema,
  revision: BotRevisionSchema,
  payload: BotInteractionPayloadSchema.optional(),
  /** Saved blocking question whose original continuation was never admitted. */
  recoveryAvailable: z.literal(true).optional(),
}).strict().refine((interaction) => interaction.payload === undefined || interaction.payload.kind === interaction.kind, {
  message: "Payload kind must match the interaction kind",
});

const answerShape = CanonicalSubmitChatInputRequestSchema.shape;

export const ResolveBotInteractionRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resume"), baseRevision: BotBaseRevisionSchema }).strict(),
  z.object({
    kind: z.literal("question"),
    baseRevision: BotBaseRevisionSchema,
    answer: answerShape.answer,
    structuredAnswers: answerShape.structuredAnswers,
  }).strict().refine((value) => value.answer !== undefined || value.structuredAnswers !== undefined, {
    message: "An answer is required",
  }),
  z.object({
    kind: z.literal("account_choice"),
    baseRevision: BotBaseRevisionSchema,
    connectionId: BotConnectionIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("connect_request"),
    baseRevision: BotBaseRevisionSchema,
    action: z.enum(["start", "cancel", "decline"]),
  }).strict(),
  z.object({
    kind: z.literal("approval"),
    baseRevision: BotBaseRevisionSchema,
    decision: z.enum(["approve", "deny"]),
  }).strict(),
]);

export const ResolveBotInteractionResponseSchema = z.object({
  interaction: z.object({
    interactionId: BotInteractionIdSchema,
    status: BotInteractionStatusSchema,
    revision: BotRevisionSchema,
  }).strict(),
  connectUrl: BotHttpsUrlSchema.optional(),
  /** Answer committed; no confirmed continuation admission yet. */
  continuationPending: z.literal(true).optional(),
}).strict();

export type BotInteractionKind = z.infer<typeof BotInteractionKindSchema>;
export type BotInteractionStatus = z.infer<typeof BotInteractionStatusSchema>;
export type BotInteractionPayload = z.infer<typeof BotInteractionPayloadSchema>;
export type BotInteraction = z.infer<typeof BotInteractionSchema>;
export type ResolveBotInteractionRequest = z.infer<typeof ResolveBotInteractionRequestSchema>;
export type ResolveBotInteractionResponse = z.infer<typeof ResolveBotInteractionResponseSchema>;
