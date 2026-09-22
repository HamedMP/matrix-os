import {
  JEV_EMAIL_TRIAGE_ANSWER_IDS,
  JEV_EMAIL_TRIAGE_INSTRUCTIONS,
  JEV_EMAIL_TRIAGE_RECIPE_ID,
  JEV_MODEL_ID,
  JevEmailTriageResultSchema,
  type JevEmailTriageResult,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const MAX_STATE_BYTES = 32 * 1024;
const textEncoder = new TextEncoder();
const BooleanQuestionSchema = z.object({
  type: z.literal("boolean"),
  instructions: z.string(),
}).strict();

function fixedQuestion(instructions: string) {
  return BooleanQuestionSchema.extend({ instructions: z.literal(instructions) });
}

const QuestionsSchema = z.object({
  urgent: fixedQuestion(JEV_EMAIL_TRIAGE_INSTRUCTIONS.urgent),
  needs_reply: fixedQuestion(JEV_EMAIL_TRIAGE_INSTRUCTIONS.needs_reply),
  personal_intro: fixedQuestion(JEV_EMAIL_TRIAGE_INSTRUCTIONS.personal_intro),
  investment: fixedQuestion(JEV_EMAIL_TRIAGE_INSTRUCTIONS.investment),
  recruiting: fixedQuestion(JEV_EMAIL_TRIAGE_INSTRUCTIONS.recruiting),
  newsletter: fixedQuestion(JEV_EMAIL_TRIAGE_INSTRUCTIONS.newsletter),
  cold_outreach: fixedQuestion(JEV_EMAIL_TRIAGE_INSTRUCTIONS.cold_outreach),
}).strict();

const FundedJevEvaluationRequestSchema = z.object({
  model: z.literal(JEV_MODEL_ID),
  state: z.string().min(1).max(MAX_STATE_BYTES)
    .refine((value) => textEncoder.encode(value).byteLength <= MAX_STATE_BYTES, "Jev state is too large"),
  questions: QuestionsSchema,
}).strict();

const AnswerSchema = z.object({
  type: z.literal("boolean"),
  probability: z.number().finite().min(0).max(1),
}).strict();
const AnswersSchema = z.object({
  urgent: AnswerSchema,
  needs_reply: AnswerSchema,
  personal_intro: AnswerSchema,
  investment: AnswerSchema,
  recruiting: AnswerSchema,
  newsletter: AnswerSchema,
  cold_outreach: AnswerSchema,
}).strict();
const GatewayCostSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/);
const UpstreamResponseSchema = z.object({
  model: z.literal(JEV_MODEL_ID),
  answers: AnswersSchema,
  usage: z.object({
    inputTokens: z.number().int().nonnegative().max(10_000_000),
    outputTokens: z.number().int().nonnegative().max(10_000_000),
  }).strict().optional(),
  providerMetadata: z.object({
    gateway: z.object({
      gatewayCost: GatewayCostSchema.optional(),
    }),
  }).optional(),
});

export interface SerializedFundedJevEvaluationRequest {
  request: z.infer<typeof FundedJevEvaluationRequestSchema>;
  body: string;
}

export interface NormalizedFundedJevEvaluation {
  result: JevEmailTriageResult;
  actualCostMicrousd: number | null;
}

export function serializeFundedJevEvaluationRequest(input: unknown): SerializedFundedJevEvaluationRequest {
  const request = FundedJevEvaluationRequestSchema.parse(input);
  const body = JSON.stringify({
    ...request,
    providerOptions: {
      gateway: { zeroDataRetention: true, only: ["typesafe-ai"] },
    },
  });
  return { request, body };
}

export function gatewayUsdToMicrousd(value: string): number {
  const parsed = GatewayCostSchema.parse(value);
  const [whole, fraction = ""] = parsed.split(".");
  const wholeMicrousd = BigInt(whole) * 1_000_000n;
  const padded = fraction.padEnd(6, "0");
  const fractionalMicrousd = BigInt(padded.slice(0, 6));
  const remainder = padded.slice(6);
  const rounded = wholeMicrousd + fractionalMicrousd + (/[1-9]/.test(remainder) ? 1n : 0n);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Jev gateway cost exceeds supported bounds");
  return Number(rounded);
}

export function normalizeFundedJevEvaluationResponse(input: {
  value: unknown;
  requestId: string;
  latencyMs: number;
}): NormalizedFundedJevEvaluation {
  const upstream = UpstreamResponseSchema.parse(input.value);
  const gatewayUsd = upstream.providerMetadata?.gateway.gatewayCost;
  const result = JevEmailTriageResultSchema.parse({
    requestId: `jev_req_${input.requestId}`,
    recipe: JEV_EMAIL_TRIAGE_RECIPE_ID,
    model: upstream.model,
    latencyMs: input.latencyMs,
    answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => ({ id, ...upstream.answers[id] })),
    ...(upstream.usage ? { usage: upstream.usage } : {}),
    ...(gatewayUsd ? { cost: { gatewayUsd } } : {}),
  });
  return {
    result,
    actualCostMicrousd: gatewayUsd === undefined ? null : gatewayUsdToMicrousd(gatewayUsd),
  };
}
