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

export const EMAIL_TRIAGE_LABELS = {
  urgent: "00 • Jev/1 Urgent",
  needsReply: "00 • Jev/2 Needs reply",
  personalIntro: "00 • Jev/3 Personal & intros",
  investment: "00 • Jev/4 Investment",
  recruiting: "00 • Jev/5 Recruiting",
  newsletter: "00 • Jev/8 Newsletter",
  coldOutreach: "00 • Jev/9 Cold outreach",
  review: "00 • Jev/Z Review",
} as const;

export interface EmailTriagePolicyInput {
  scores: JevEmailTriageScores;
  verified: boolean;
  ageDays: number;
}

export interface EmailTriagePolicyResult {
  scores: JevEmailTriageScores;
  requiresFullContext: boolean;
  labels: string[];
  archive: { removeLabelIds: ["INBOX"] } | null;
}

/** Pure policy shared by the Gateway tests and every agent-facing Jev adapter. */
export function evaluateEmailTriagePolicy(input: EmailTriagePolicyInput): EmailTriagePolicyResult {
  const { scores, verified } = input;
  const ageDays = Number.isFinite(input.ageDays) && input.ageDays >= 0
    ? input.ageDays
    : Number.POSITIVE_INFINITY;
  const requiresFullContext = !verified && (
    scores.cold_outreach >= 0.75
    || scores.urgent >= 0.40
    || scores.needs_reply >= 0.70
  );

  const urgent = ageDays <= 30
    && scores.urgent >= (verified ? 0.55 : 0.70)
    && scores.newsletter < 0.80
    && scores.cold_outreach < 0.80;
  const needsReply = ageDays <= 90
    && scores.needs_reply >= (verified ? 0.75 : 0.85)
    && scores.newsletter < 0.75
    && scores.cold_outreach < 0.85;
  const personalIntro = scores.personal_intro >= (verified ? 0.75 : 0.85);
  const investment = scores.investment >= (verified ? 0.75 : 0.85);
  const recruiting = scores.recruiting >= (verified ? 0.75 : 0.85);
  const newsletter = scores.newsletter >= (verified ? 0.85 : 0.90);
  const coldOutreach = scores.cold_outreach >= (verified ? 0.85 : 0.90);

  const mayArchive = verified
    && scores.cold_outreach >= 0.92
    && scores.urgent <= 0.20
    && scores.needs_reply <= 0.20
    && scores.personal_intro <= 0.30
    && scores.investment <= 0.20
    && scores.recruiting <= 0.20;

  const review = !mayArchive && ageDays <= 90 && (
    scores.cold_outreach >= 0.65
    || (scores.urgent >= 0.40 && !urgent)
    || (
      scores.needs_reply >= 0.65
      && !needsReply
      && scores.newsletter < 0.75
      && scores.cold_outreach < 0.85
    )
  );

  const labels: string[] = [];
  if (urgent) labels.push(EMAIL_TRIAGE_LABELS.urgent);
  if (needsReply) labels.push(EMAIL_TRIAGE_LABELS.needsReply);
  if (personalIntro) labels.push(EMAIL_TRIAGE_LABELS.personalIntro);
  if (investment) labels.push(EMAIL_TRIAGE_LABELS.investment);
  if (recruiting) labels.push(EMAIL_TRIAGE_LABELS.recruiting);
  if (newsletter) labels.push(EMAIL_TRIAGE_LABELS.newsletter);
  if (coldOutreach) labels.push(EMAIL_TRIAGE_LABELS.coldOutreach);
  if (review) labels.push(EMAIL_TRIAGE_LABELS.review);

  return {
    scores,
    requiresFullContext,
    labels,
    archive: mayArchive ? { removeLabelIds: ["INBOX"] } : null,
  };
}
