import {
  JEV_EMAIL_TRIAGE_ANSWER_IDS,
  JEV_EMAIL_TRIAGE_INSTRUCTIONS,
  JEV_EMAIL_TRIAGE_RECIPE_ID,
  JEV_MODEL_ID,
  JEV_PRICING_VERSION,
  JevEmailTriageResultSchema,
  type JevEmailTriageResult,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const MAX_STATE_BYTES = 32 * 1024;
const JEV_INPUT_PRICE_NANOUSD_PER_TOKEN = 42n;
const JEV_PRICING_VALID_THROUGH = "2026-09-30T23:59:59.999Z";
const NANOUSD_PER_USD = 1_000_000_000n;
const NANOUSD_PER_MICROUSD = 1_000n;
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
  type: z.literal("noul"),
  noul: z.number().finite().min(0).max(1),
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
const UpstreamResponseSchema = z.object({
  model: z.string().min(1).max(128).regex(/^jev-[a-zA-Z0-9._-]+$/),
  answers: AnswersSchema,
  usage: z.object({
    input_tokens: z.number().int().nonnegative().max(10_000_000),
    output_tokens: z.number().int().nonnegative().max(10_000_000),
  }).strict(),
}).strict();
const CloudflareJevResponseSchema = z.object({
  result: z.object({
    state: z.literal("Completed"),
    result: UpstreamResponseSchema,
    gatewayMetadata: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  success: z.literal(true),
  errors: z.array(z.unknown()).max(16),
  messages: z.array(z.unknown()).max(16),
}).strict();

export interface SerializedFundedJevEvaluationRequest {
  request: z.infer<typeof FundedJevEvaluationRequestSchema>;
  body: string;
}

export interface NormalizedFundedJevEvaluation {
  result: JevEmailTriageResult;
  actualCostMicrousd: number | null;
  resolvedModel: string;
  pricingVersion: typeof JEV_PRICING_VERSION;
}

export interface JevPricingSnapshot {
  version: typeof JEV_PRICING_VERSION;
  nanoUsdPerInputToken: bigint;
}

export function reviewedJevPricing(at: Date): JevPricingSnapshot {
  if (!Number.isFinite(at.getTime()) || at.getTime() > Date.parse(JEV_PRICING_VALID_THROUGH)) {
    throw new Error("Jev pricing has expired");
  }
  return { version: JEV_PRICING_VERSION, nanoUsdPerInputToken: JEV_INPUT_PRICE_NANOUSD_PER_TOKEN };
}

export function serializeFundedJevEvaluationRequest(input: unknown): SerializedFundedJevEvaluationRequest {
  const request = FundedJevEvaluationRequestSchema.parse(input);
  const body = JSON.stringify({
    model: JEV_MODEL_ID,
    input: {
      state: request.state,
      questions: Object.fromEntries(JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => [id, {
        type: "noul",
        instructions: request.questions[id].instructions,
      }])),
    },
  });
  return { request, body };
}

export function jevInputTokensToMicrousd(inputTokens: number, pricing: JevPricingSnapshot): number {
  const tokens = z.number().int().nonnegative().max(10_000_000).parse(inputTokens);
  const nanoUsd = BigInt(tokens) * pricing.nanoUsdPerInputToken;
  const rounded = (nanoUsd + NANOUSD_PER_MICROUSD - 1n) / NANOUSD_PER_MICROUSD;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Jev gateway cost exceeds supported bounds");
  return Number(rounded);
}

function jevInputTokensToGatewayUsd(inputTokens: number, pricing: JevPricingSnapshot): string {
  const nanoUsd = BigInt(inputTokens) * pricing.nanoUsdPerInputToken;
  const whole = nanoUsd / NANOUSD_PER_USD;
  const fraction = (nanoUsd % NANOUSD_PER_USD).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

export function normalizeFundedJevEvaluationResponse(input: {
  value: unknown;
  requestId: string;
  latencyMs: number;
  pricing: JevPricingSnapshot;
}): NormalizedFundedJevEvaluation {
  const upstream = CloudflareJevResponseSchema.parse(input.value).result.result;
  const gatewayUsd = jevInputTokensToGatewayUsd(upstream.usage.input_tokens, input.pricing);
  const result = JevEmailTriageResultSchema.parse({
    requestId: `jev_req_${input.requestId}`,
    recipe: JEV_EMAIL_TRIAGE_RECIPE_ID,
    model: JEV_MODEL_ID,
    latencyMs: input.latencyMs,
    answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => ({
      id,
      type: "boolean",
      probability: upstream.answers[id].noul,
    })),
    usage: {
      inputTokens: upstream.usage.input_tokens,
      outputTokens: upstream.usage.output_tokens,
    },
    cost: { gatewayUsd },
    provenance: { resolvedModel: upstream.model, pricingVersion: input.pricing.version },
  });
  return {
    result,
    actualCostMicrousd: jevInputTokensToMicrousd(upstream.usage.input_tokens, input.pricing),
    resolvedModel: upstream.model,
    pricingVersion: input.pricing.version,
  };
}

export function cloudflareJevTarget(gatewayBaseUrl: string): { url: string; gatewayId: string } {
  const parts = new URL(gatewayBaseUrl).pathname.split("/");
  const accountId = parts[2];
  const gatewayId = parts[3];
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || !/^[a-zA-Z0-9_-]{1,64}$/.test(gatewayId ?? "")) {
    throw new Error("Invalid Cloudflare Jev gateway configuration");
  }
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`,
    gatewayId: gatewayId!,
  };
}
