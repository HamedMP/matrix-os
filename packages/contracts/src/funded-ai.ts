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

export const FundedAiEffectivePolicySchema = z.object({
  enabled: z.boolean(),
  globalRevision: RevisionSchema,
  runtimeRevision: RevisionSchema,
  allowedModelIds: UniqueModelIdsSchema,
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
}).strict();

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
}).strict();

const SafeErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("unauthorized"), message: z.literal("Unauthorized") }).strict(),
  z.object({ code: z.literal("access_disabled"), message: z.literal("Matrix-funded AI is unavailable") }).strict(),
  z.object({ code: z.literal("model_not_allowed"), message: z.literal("This model is not available") }).strict(),
  z.object({ code: z.literal("rate_limited"), message: z.literal("Try again later") }).strict(),
  z.object({ code: z.literal("revision_conflict"), message: z.literal("Policy changed; refresh and try again") }).strict(),
  z.object({ code: z.literal("invalid_request"), message: z.literal("Invalid request") }).strict(),
  z.object({ code: z.literal("not_found"), message: z.literal("Runtime not found") }).strict(),
  z.object({ code: z.literal("unavailable"), message: z.literal("Service unavailable") }).strict(),
]);

export const FundedAiSafeErrorSchema = z.object({ error: SafeErrorSchema }).strict();

export type FundedAiIdentity = z.infer<typeof FundedAiIdentitySchema>;
export type FundedAiGlobalPolicy = z.infer<typeof FundedAiGlobalPolicySchema>;
export type FundedAiEffectivePolicy = z.infer<typeof FundedAiEffectivePolicySchema>;
export type FundedAiRuntimeCredentialIssueResponse = z.infer<typeof FundedAiRuntimeCredentialIssueResponseSchema>;
export type FundedAiAuthorizationRequest = z.infer<typeof FundedAiAuthorizationRequestSchema>;
export type FundedAiAuthorizationResponse = z.infer<typeof FundedAiAuthorizationResponseSchema>;
export type FundedAiSafeError = z.infer<typeof FundedAiSafeErrorSchema>;
