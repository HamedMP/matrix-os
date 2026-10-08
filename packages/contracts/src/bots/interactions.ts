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

export const BotInteractionKindSchema = z.enum(["question", "account_choice", "connect_request", "approval"]);
export const BotInteractionStatusSchema = z.enum(["pending", "resolved", "expired", "cancelled"]);

const QuestionPayloadSchema = z.object({
  kind: z.literal("question"),
  questions: UserInputQuestionListSchema,
}).strict();

const AccountChoicePayloadSchema = z.object({
  kind: z.literal("account_choice"),
  service: BotIntegrationServiceSchema,
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
  preview: canonicalBoundedText(4_096, 16 * 1024),
  policyRevision: BotRevisionSchema,
}).strict();

export const BotInteractionPayloadSchema = z.discriminatedUnion("kind", [
  QuestionPayloadSchema,
  AccountChoicePayloadSchema,
  ConnectRequestPayloadSchema,
  ApprovalPayloadSchema,
]).refine((payload) => canonicalEncodedByteLength(payload) <= MAX_PAYLOAD_BYTES, { message: "Interaction payload is too large" });

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
}).strict().refine((interaction) => interaction.payload === undefined || interaction.payload.kind === interaction.kind, {
  message: "Payload kind must match the interaction kind",
});

const answerShape = CanonicalSubmitChatInputRequestSchema.shape;

export const ResolveBotInteractionRequestSchema = z.discriminatedUnion("kind", [
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
}).strict();

export type BotInteractionKind = z.infer<typeof BotInteractionKindSchema>;
export type BotInteractionStatus = z.infer<typeof BotInteractionStatusSchema>;
export type BotInteractionPayload = z.infer<typeof BotInteractionPayloadSchema>;
export type BotInteraction = z.infer<typeof BotInteractionSchema>;
export type ResolveBotInteractionRequest = z.infer<typeof ResolveBotInteractionRequestSchema>;
export type ResolveBotInteractionResponse = z.infer<typeof ResolveBotInteractionResponseSchema>;
