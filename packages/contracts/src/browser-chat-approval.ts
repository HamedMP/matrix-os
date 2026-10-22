import { z } from "zod/v4";

const Ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const BrowserActionDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const BrowserDecisionSchema = z.enum(["allow_once", "allow_in_chat", "not_now", "cancel"]);
export const BrowserApprovalIntentSchema = z.strictObject({
  kind: z.literal("shared_chrome"), decision: BrowserDecisionSchema, leaseEpoch: z.uuid(),
  challengeRevision: z.number().int().nonnegative().max(2_147_483_647), scopeVersion: z.literal(1),
});
export const BrowserApprovalIdentitySchema = z.strictObject({
  ownerId: Ref, chatId: Ref, runId: Ref, approvalId: Ref, leaseEpoch: z.uuid(),
  actionDigest: BrowserActionDigestSchema, challengeRevision: z.number().int().nonnegative().max(2_147_483_647),
  scopeVersion: z.literal(1),
});
export const BrowserDecisionTupleSchema = z.strictObject({
  handle: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/), actorId: Ref,
  runtimeSlot: Ref, chatId: Ref, runId: Ref, approvalId: Ref, clientRequestId: Ref,
  browserDecision: BrowserDecisionSchema, actionDigest: BrowserActionDigestSchema,
  leaseEpoch: z.uuid(), challengeRevision: z.number().int().nonnegative().max(2_147_483_647), scopeVersion: z.literal(1),
});
export const BrowserGrantRevokeRequestSchema = z.strictObject({ clientRequestId: Ref,
  baseRevision: z.number().int().nonnegative().max(2_147_483_647) });
export const BrowserGrantRevokeTupleSchema = z.strictObject({
  handle: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/), actorId: Ref,
  runtimeSlot: Ref, chatId: Ref, grantId: z.uuid(), clientRequestId: Ref,
  baseRevision: z.number().int().nonnegative().max(2_147_483_647),
});
export const BrowserDecisionProofSchema = BrowserDecisionTupleSchema.extend({
  version: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{32}$/),
  bodyDigest: BrowserActionDigestSchema, expiresAt: z.number().int().positive(),
}).strict();
export const BrowserRevokeProofSchema = BrowserGrantRevokeTupleSchema.extend({
  version: z.literal(1), operation: z.literal("revoke_grant"), nonce: z.string().regex(/^[a-f0-9]{32}$/),
  bodyDigest: BrowserActionDigestSchema, expiresAt: z.number().int().positive(),
}).strict();
export const BrowserGrantViewSchema = z.strictObject({ id: z.uuid(), chatId: Ref,
  capability: z.literal("shared_chrome"), scopeVersion: z.literal(1),
  revision: z.number().int().positive().max(2_147_483_647), state: z.enum(["active", "revoked"]),
  createdAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable(),
});
export const BrowserApprovalLifecycleSchema = z.strictObject({
  kind: z.literal("shared_chrome"), leaseEpoch: z.uuid(), challengeRevision: z.number().int().nonnegative(),
  scopeVersion: z.literal(1), expiresAt: z.iso.datetime(),
  resolution: z.enum(["allowed_once", "allowed_in_chat", "declined", "cancelled", "expired", "interrupted"]).optional(),
});
export type BrowserApprovalIdentity = z.infer<typeof BrowserApprovalIdentitySchema>;
export type BrowserDecisionTuple = z.infer<typeof BrowserDecisionTupleSchema>;
export type BrowserDecisionProof = z.infer<typeof BrowserDecisionProofSchema>;
export type BrowserGrantRevokeTuple = z.infer<typeof BrowserGrantRevokeTupleSchema>;
export type BrowserRevokeProof = z.infer<typeof BrowserRevokeProofSchema>;
export type BrowserGrantView = z.infer<typeof BrowserGrantViewSchema>;
export function browserCanonicalDecision(value: z.infer<typeof BrowserDecisionSchema>): "approve" | "decline" | "cancel" {
  return value === "not_now" ? "decline" : value === "cancel" ? "cancel" : "approve";
}
