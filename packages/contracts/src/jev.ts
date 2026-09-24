import { z } from "zod/v4";

export const JEV_EMAIL_TRIAGE_RECIPE_ID = "email-triage-v1" as const;
export const JEV_MODEL_ID = "typesafe/jev" as const;
export const JEV_EMAIL_TRIAGE_ANSWER_IDS = [
  "urgent",
  "needs_reply",
  "personal_intro",
  "investment",
  "recruiting",
  "newsletter",
  "cold_outreach",
] as const;

export const JEV_EMAIL_TRIAGE_INSTRUCTIONS = Object.freeze({
  urgent: "Does this email contain time-sensitive information that likely requires the recipient's prompt attention?",
  needs_reply: "Does this email reasonably expect a direct reply or follow-up from the recipient?",
  personal_intro: "Is this personal correspondence or a meaningful introduction involving the recipient?",
  investment: "Is this email about investment, fundraising, or an investor relationship?",
  recruiting: "Is this email about recruiting, a candidate, employment, or a job opportunity?",
  newsletter: "Is this email a newsletter, digest, or broadcast subscription message?",
  cold_outreach: "Is this unsolicited outreach without evidence of an established relationship with the recipient?",
} as const);

const MAX_JEV_STATE_BYTES = 32 * 1024;
const textEncoder = new TextEncoder();

export const JevEmailTriageAnswerIdSchema = z.enum(JEV_EMAIL_TRIAGE_ANSWER_IDS);

export const JevEvaluateRequestSchema = z.object({
  recipe: z.literal(JEV_EMAIL_TRIAGE_RECIPE_ID),
  state: z.string().min(1).max(MAX_JEV_STATE_BYTES)
    .refine((value) => textEncoder.encode(value).byteLength <= MAX_JEV_STATE_BYTES, "Jev state is too large"),
  idempotencyKey: z.string()
    .min(8)
    .max(240)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "Invalid Jev idempotency key"),
}).strict();

export const JevBooleanAnswerSchema = z.object({
  id: JevEmailTriageAnswerIdSchema,
  type: z.literal("boolean"),
  probability: z.number().min(0).max(1),
}).strict();

export const JevEmailTriageScoresSchema = z.object({
  urgent: z.number().min(0).max(1),
  needs_reply: z.number().min(0).max(1),
  personal_intro: z.number().min(0).max(1),
  investment: z.number().min(0).max(1),
  recruiting: z.number().min(0).max(1),
  newsletter: z.number().min(0).max(1),
  cold_outreach: z.number().min(0).max(1),
}).strict();

export const JevEmailTriageResultSchema = z.object({
  requestId: z.string().min(12).max(160).regex(/^jev_req_[A-Za-z0-9_-]+$/),
  recipe: z.literal(JEV_EMAIL_TRIAGE_RECIPE_ID),
  model: z.literal(JEV_MODEL_ID),
  latencyMs: z.number().int().nonnegative().max(10 * 60_000),
  answers: z.array(JevBooleanAnswerSchema).length(JEV_EMAIL_TRIAGE_ANSWER_IDS.length),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict().optional(),
  cost: z.object({
    gatewayUsd: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/),
  }).strict().optional(),
}).strict().superRefine((result, context) => {
  const actualIds = new Set(result.answers.map((answer) => answer.id));
  for (const id of JEV_EMAIL_TRIAGE_ANSWER_IDS) {
    if (!actualIds.has(id)) {
      context.addIssue({ code: "custom", path: ["answers"], message: `Missing Jev answer: ${id}` });
    }
  }
  if (actualIds.size !== result.answers.length) {
    context.addIssue({ code: "custom", path: ["answers"], message: "Jev answer IDs must be unique" });
  }
});

export type JevEvaluateRequest = z.infer<typeof JevEvaluateRequestSchema>;
export type JevEmailTriageAnswerId = z.infer<typeof JevEmailTriageAnswerIdSchema>;
export type JevBooleanAnswer = z.infer<typeof JevBooleanAnswerSchema>;
export type JevEmailTriageScores = z.infer<typeof JevEmailTriageScoresSchema>;
export type JevEmailTriageResult = z.infer<typeof JevEmailTriageResultSchema>;
