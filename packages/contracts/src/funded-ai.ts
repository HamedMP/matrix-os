import { z } from "zod/v4";
import { canonicalReferenceId } from "#canonical-chat-primitives";
import { IsoTimestampSchema, ProviderModelReferenceSchema } from "#contract-primitives";

export const FUNDED_AI_AUDIENCE = "matrix-funded-relay" as const;
export const FUNDED_AI_SCOPE = "ai:invoke" as const;

const RevisionSchema = z.number().int().nonnegative();
const RuntimeSlotSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/);
const UniqueModelIdsSchema = z.array(ProviderModelReferenceSchema).max(64)
  .refine((models) => new Set(models).size === models.length, "Model IDs must be unique");
const TokenIdSchema = canonicalReferenceId(80);
const MicrousdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OpaqueCredentialSchema = z.string()
  .min(64)
  .max(256)
  .regex(/^sk-matrix-funded-[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}\.[A-Za-z0-9_-]{43}$/);

export const FundedAiIdentitySchema = z.object({
  ownerId: canonicalReferenceId(160),
  machineId: canonicalReferenceId(160),
  runtimeSlot: RuntimeSlotSchema,
}).strict();

export const FundedAiGlobalPolicySchema = z.object({
  enabled: z.boolean(),
  revision: RevisionSchema,
  allowedModelIds: UniqueModelIdsSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export const FundedAiOperatorGlobalPolicyUpdateRequestSchema = z.object({
  expectedRevision: RevisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
  enabled: z.boolean(),
  allowedModelIds: UniqueModelIdsSchema,
}).strict();

export const FundedAiOperatorGlobalPolicyResponseSchema = z.object({
  contractVersion: z.literal(1),
  policy: FundedAiGlobalPolicySchema,
}).strict();

export const FundedAiOperatorRuntimePolicyUpdateRequestSchema = z.object({
  expectedRevision: RevisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
  enabled: z.boolean(),
  allowedModelIds: UniqueModelIdsSchema,
  monthlyBudgetMicrousd: MicrousdSchema,
  expiresAt: IsoTimestampSchema.nullable(),
}).strict();

export const FundedAiOperatorRuntimePolicyResponseSchema = z.object({
  contractVersion: z.literal(1),
  policy: z.object({
    enabled: z.boolean(),
    revision: RevisionSchema,
    allowedModelIds: UniqueModelIdsSchema,
    monthlyBudgetMicrousd: MicrousdSchema,
    expiresAt: IsoTimestampSchema.nullable(),
    updatedAt: IsoTimestampSchema,
  }).strict(),
}).strict();

export const FundedAiPromotionalGrantResponseSchema = z.object({
  contractVersion: z.literal(1),
  grant: z.object({
    kind: z.literal("promotional"),
    amountMicrousd: MicrousdSchema.min(1),
    expiresAt: IsoTimestampSchema,
    createdAt: IsoTimestampSchema,
    status: z.literal("active"),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.grant.expiresAt) <= Date.parse(value.grant.createdAt)) {
    ctx.addIssue({ code: "custom", path: ["grant", "expiresAt"], message: "Promotional grant must expire after creation" });
  }
});

export const FundedAiEffectivePolicySchema = z.object({
  enabled: z.boolean(),
  globalRevision: RevisionSchema,
  runtimeRevision: RevisionSchema,
  allowedModelIds: UniqueModelIdsSchema,
  monthlyBudgetMicrousd: MicrousdSchema,
  checkedAt: IsoTimestampSchema,
  staleAfter: IsoTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.staleAfter) <= Date.parse(value.checkedAt)) {
    ctx.addIssue({ code: "custom", path: ["staleAfter"], message: "Policy freshness must end after it was checked" });
  }
  if (Date.parse(value.staleAfter) - Date.parse(value.checkedAt) > 5 * 60_000) {
    ctx.addIssue({ code: "custom", path: ["staleAfter"], message: "Policy freshness window is too long" });
  }
  if (!value.enabled && value.allowedModelIds.length > 0) {
    ctx.addIssue({ code: "custom", path: ["allowedModelIds"], message: "Disabled policy cannot allow models" });
  }
});

export const FundedAiRuntimeCredentialIssueResponseSchema = z.object({
  contractVersion: z.literal(1),
  credential: z.object({
    token: OpaqueCredentialSchema,
    tokenId: TokenIdSchema,
    audience: z.literal(FUNDED_AI_AUDIENCE),
    scope: z.literal(FUNDED_AI_SCOPE),
    issuedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
  }).strict(),
  identity: FundedAiIdentitySchema,
  policy: FundedAiEffectivePolicySchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.credential.expiresAt) <= Date.parse(value.credential.issuedAt)) {
    ctx.addIssue({ code: "custom", path: ["credential", "expiresAt"], message: "Credential must expire after issuance" });
  }
  if (Date.parse(value.credential.expiresAt) - Date.parse(value.credential.issuedAt) > 60 * 60_000) {
    ctx.addIssue({ code: "custom", path: ["credential", "expiresAt"], message: "Credential lifetime is too long" });
  }
  const tokenPrefix = `sk-matrix-funded-${value.credential.tokenId}.`;
  if (!value.credential.token.startsWith(tokenPrefix)) {
    ctx.addIssue({ code: "custom", path: ["credential", "tokenId"], message: "Credential token ID does not match" });
  }
});

export const FundedAiAuthorizationRequestSchema = z.object({
  credential: OpaqueCredentialSchema,
  requestId: canonicalReferenceId(160),
  modelId: ProviderModelReferenceSchema,
  maxCostMicrousd: MicrousdSchema.min(1),
}).strict();

export const FundedAiPolicyCheckRequestSchema = z.object({
  credential: OpaqueCredentialSchema,
  modelId: ProviderModelReferenceSchema,
}).strict();

export const FundedAiPolicyCheckResponseSchema = z.object({
  contractVersion: z.literal(1),
  authorized: z.literal(true),
  identity: FundedAiIdentitySchema.extend({
    tokenId: TokenIdSchema,
    audience: z.literal(FUNDED_AI_AUDIENCE),
    scope: z.literal(FUNDED_AI_SCOPE),
    expiresAt: IsoTimestampSchema,
  }).strict(),
  policy: FundedAiEffectivePolicySchema,
}).strict();

export const FundedAiFundingSummarySchema = z.object({
  asOf: IsoTimestampSchema,
  periodStart: IsoTimestampSchema,
  monthlyBudgetMicrousd: MicrousdSchema,
  settledThisMonthMicrousd: MicrousdSchema,
  reservedMicrousd: MicrousdSchema,
  reservedThisMonthMicrousd: MicrousdSchema,
  promotionalBalanceMicrousd: MicrousdSchema,
  addonBalanceMicrousd: MicrousdSchema,
  creditBalanceMicrousd: MicrousdSchema,
  fundingShortfallMicrousd: MicrousdSchema.optional(),
  remainingBalanceMicrousd: MicrousdSchema,
  remainingBudgetMicrousd: MicrousdSchema,
}).strict().superRefine((value, ctx) => {
  const creditTotal = value.promotionalBalanceMicrousd + value.addonBalanceMicrousd;
  if (!Number.isSafeInteger(creditTotal) || value.creditBalanceMicrousd !== creditTotal) {
    ctx.addIssue({ code: "custom", path: ["creditBalanceMicrousd"], message: "Credit buckets must equal total credit" });
  }
  if (value.remainingBalanceMicrousd !== Math.max(
    0,
    value.creditBalanceMicrousd - value.reservedMicrousd - (value.fundingShortfallMicrousd ?? 0),
  )) {
    ctx.addIssue({ code: "custom", path: ["remainingBalanceMicrousd"], message: "Remaining credit is inconsistent" });
  }
  const expectedBudget = Math.max(
    0,
    value.monthlyBudgetMicrousd - value.settledThisMonthMicrousd - value.reservedThisMonthMicrousd,
  );
  if (value.remainingBudgetMicrousd !== expectedBudget) {
    ctx.addIssue({ code: "custom", path: ["remainingBudgetMicrousd"], message: "Remaining budget is inconsistent" });
  }
  if (value.reservedThisMonthMicrousd > value.reservedMicrousd) {
    ctx.addIssue({ code: "custom", path: ["reservedThisMonthMicrousd"], message: "Monthly reservations cannot exceed all reservations" });
  }
  const period = new Date(value.periodStart);
  const canonicalPeriod = new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth(), 1)).toISOString();
  if (value.periodStart !== canonicalPeriod) {
    ctx.addIssue({ code: "custom", path: ["periodStart"], message: "Funding period must start at a UTC month boundary" });
  }
});

/** Shell-safe metering projection for one server-derived runtime identity. */
export const FundedAiRuntimeFundingSummaryResponseSchema = z.object({
  contractVersion: z.literal(1),
  funding: FundedAiFundingSummarySchema,
  policy: FundedAiEffectivePolicySchema,
}).strict().superRefine((value, ctx) => {
  if (value.funding.monthlyBudgetMicrousd !== value.policy.monthlyBudgetMicrousd) {
    ctx.addIssue({ code: "custom", path: ["policy", "monthlyBudgetMicrousd"], message: "Policy and funding budgets must match" });
  }
  if (value.funding.asOf !== value.policy.checkedAt) {
    ctx.addIssue({ code: "custom", path: ["policy", "checkedAt"], message: "Policy and funding timestamps must match" });
  }
});

export const FundedAiAuthorizationResponseSchema = z.object({
  contractVersion: z.literal(1),
  authorized: z.literal(true),
  identity: FundedAiIdentitySchema.extend({
    tokenId: TokenIdSchema,
    audience: z.literal(FUNDED_AI_AUDIENCE),
    scope: z.literal(FUNDED_AI_SCOPE),
    expiresAt: IsoTimestampSchema,
  }).strict(),
  policy: FundedAiEffectivePolicySchema,
  funding: FundedAiFundingSummarySchema,
  reservation: z.object({
    reservationId: canonicalReferenceId(160),
    requestId: canonicalReferenceId(160),
    modelId: ProviderModelReferenceSchema,
    reservedMicrousd: MicrousdSchema.min(1),
    remainingBalanceMicrousd: MicrousdSchema,
    remainingBudgetMicrousd: MicrousdSchema,
    periodStart: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    status: z.literal("reserved"),
  }).strict(),
}).strict();

export const FundedAiSettlementRequestSchema = z.object({
  reservationId: canonicalReferenceId(160),
  tokenId: TokenIdSchema,
  actualCostMicrousd: MicrousdSchema,
}).strict();

export const FundedAiStartRequestSchema = z.object({
  reservationId: canonicalReferenceId(160),
  tokenId: TokenIdSchema,
}).strict();

export const FundedAiStartResponseSchema = z.object({
  contractVersion: z.literal(1),
  reservationId: canonicalReferenceId(160),
  requestId: canonicalReferenceId(160),
  tokenId: TokenIdSchema,
  startedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  status: z.literal("in_flight"),
}).strict();

export const FundedAiSettlementResponseSchema = z.object({
  contractVersion: z.literal(1),
  reservationId: canonicalReferenceId(160),
  requestId: canonicalReferenceId(160),
  tokenId: TokenIdSchema,
  actualCostMicrousd: MicrousdSchema,
  releasedMicrousd: MicrousdSchema,
  remainingBalanceMicrousd: MicrousdSchema,
  remainingBudgetMicrousd: MicrousdSchema,
  funding: FundedAiFundingSummarySchema,
  settledAt: IsoTimestampSchema,
  status: z.literal("settled"),
}).strict();

export const FundedAiReleaseRequestSchema = z.object({
  reservationId: canonicalReferenceId(160),
  tokenId: TokenIdSchema,
  reason: z.literal("pre_upstream_failure"),
}).strict();

export const FundedAiReleaseResponseSchema = z.object({
  contractVersion: z.literal(1),
  reservationId: canonicalReferenceId(160),
  requestId: canonicalReferenceId(160),
  tokenId: TokenIdSchema,
  releasedMicrousd: MicrousdSchema.min(1),
  releasedAt: IsoTimestampSchema,
  reason: z.literal("pre_upstream_failure"),
  status: z.literal("released"),
  funding: FundedAiFundingSummarySchema,
}).strict();

const SafeErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("unauthorized"), message: z.literal("Unauthorized") }).strict(),
  z.object({ code: z.literal("access_disabled"), message: z.literal("Matrix-funded AI is unavailable") }).strict(),
  z.object({ code: z.literal("model_not_allowed"), message: z.literal("This model is not available") }).strict(),
  z.object({ code: z.literal("rate_limited"), message: z.literal("Try again later") }).strict(),
  z.object({ code: z.literal("revision_conflict"), message: z.literal("Policy changed; refresh and try again") }).strict(),
  z.object({ code: z.literal("insufficient_credit"), message: z.literal("Not enough Matrix AI credit") }).strict(),
  z.object({ code: z.literal("budget_exceeded"), message: z.literal("Monthly AI budget reached") }).strict(),
  z.object({ code: z.literal("idempotency_conflict"), message: z.literal("Request already used") }).strict(),
  z.object({ code: z.literal("reservation_expired"), message: z.literal("AI usage reservation expired") }).strict(),
  z.object({ code: z.literal("over_settlement"), message: z.literal("AI usage exceeds its reservation") }).strict(),
  z.object({ code: z.literal("reservation_closed"), message: z.literal("AI usage reservation is already closed") }).strict(),
  z.object({ code: z.literal("invalid_request"), message: z.literal("Invalid request") }).strict(),
  z.object({ code: z.literal("not_found"), message: z.literal("Runtime not found") }).strict(),
  z.object({ code: z.literal("unavailable"), message: z.literal("Service unavailable") }).strict(),
]);

export const FundedAiSafeErrorSchema = z.object({ error: SafeErrorSchema }).strict();

export type FundedAiIdentity = z.infer<typeof FundedAiIdentitySchema>;
export type FundedAiGlobalPolicy = z.infer<typeof FundedAiGlobalPolicySchema>;
export type FundedAiOperatorGlobalPolicyUpdateRequest = z.infer<typeof FundedAiOperatorGlobalPolicyUpdateRequestSchema>;
export type FundedAiOperatorGlobalPolicyResponse = z.infer<typeof FundedAiOperatorGlobalPolicyResponseSchema>;
export type FundedAiOperatorRuntimePolicyUpdateRequest = z.infer<typeof FundedAiOperatorRuntimePolicyUpdateRequestSchema>;
export type FundedAiOperatorRuntimePolicyResponse = z.infer<typeof FundedAiOperatorRuntimePolicyResponseSchema>;
export type FundedAiPromotionalGrantResponse = z.infer<typeof FundedAiPromotionalGrantResponseSchema>;
export type FundedAiEffectivePolicy = z.infer<typeof FundedAiEffectivePolicySchema>;
export type FundedAiRuntimeCredentialIssueResponse = z.infer<typeof FundedAiRuntimeCredentialIssueResponseSchema>;
export type FundedAiAuthorizationRequest = z.infer<typeof FundedAiAuthorizationRequestSchema>;
export type FundedAiAuthorizationResponse = z.infer<typeof FundedAiAuthorizationResponseSchema>;
export type FundedAiPolicyCheckRequest = z.infer<typeof FundedAiPolicyCheckRequestSchema>;
export type FundedAiPolicyCheckResponse = z.infer<typeof FundedAiPolicyCheckResponseSchema>;
export type FundedAiSettlementRequest = z.infer<typeof FundedAiSettlementRequestSchema>;
export type FundedAiSettlementResponse = z.infer<typeof FundedAiSettlementResponseSchema>;
export type FundedAiStartRequest = z.infer<typeof FundedAiStartRequestSchema>;
export type FundedAiStartResponse = z.infer<typeof FundedAiStartResponseSchema>;
export type FundedAiReleaseRequest = z.infer<typeof FundedAiReleaseRequestSchema>;
export type FundedAiReleaseResponse = z.infer<typeof FundedAiReleaseResponseSchema>;
export type FundedAiFundingSummary = z.infer<typeof FundedAiFundingSummarySchema>;
export type FundedAiRuntimeFundingSummaryResponse = z.infer<typeof FundedAiRuntimeFundingSummaryResponseSchema>;
export type FundedAiSafeError = z.infer<typeof FundedAiSafeErrorSchema>;
