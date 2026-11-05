import { z } from "zod/v4";
import { CanonicalCreateChatTurnRequestSchema, type CanonicalCreateChatTurnRequest } from "#canonical-chat-api";
import { CanonicalChatRequestIdSchema } from "#canonical-chat";

export const ROUTINE_FULL_ACCESS_SCOPE_HEADER = "x-matrix-routine-full-access-scope";
export const ROUTINE_FULL_ACCESS_PROOF_HEADER = "x-matrix-routine-full-access-proof";
export const RoutineFullAccessIdSchema = z.string().regex(/^rcfull_[a-f0-9]{32}$/);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const routing = { handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), runtimeSlot: ref, machineId: ref, ownerId: ref, chatId: ref };
export const RoutineFullAccessDecisionSubmitSchema = z.strictObject({
  scopeDigest: hex64, decision: z.enum(["approve", "decline"]),
  clientRequestId: z.union([z.uuid(), z.string().regex(/^req_[a-f0-9]{32}$/)]).transform(value => value.toLowerCase()),
});
export const RoutineFullAccessDecisionTupleSchema = RoutineFullAccessDecisionSubmitSchema.extend({
  ...routing, kind: z.literal("scope_decision"), challengeId: RoutineFullAccessIdSchema,
});
export const RoutineFullAccessTurnTupleSchema = z.strictObject({
  ...routing, kind: z.literal("turn"), scopeId: RoutineFullAccessIdSchema,
  clientRequestId: CanonicalChatRequestIdSchema, requestDigest: hex64,
});
export const RoutineFullAccessTupleSchema = z.discriminatedUnion("kind", [RoutineFullAccessDecisionTupleSchema, RoutineFullAccessTurnTupleSchema]);
const proof = { purpose: z.literal("routine_cli_full_access_origin"), version: z.literal(1),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), nonce: z.string().regex(/^[a-f0-9]{32}$/), bodyDigest: hex64 };
export const RoutineFullAccessProofSchema = z.discriminatedUnion("kind", [RoutineFullAccessDecisionTupleSchema.extend(proof), RoutineFullAccessTurnTupleSchema.extend(proof)]);
export type RoutineFullAccessDecisionSubmit = z.infer<typeof RoutineFullAccessDecisionSubmitSchema>;
export type RoutineFullAccessDecisionTuple = z.infer<typeof RoutineFullAccessDecisionTupleSchema>;
export type RoutineFullAccessTurnTuple = z.infer<typeof RoutineFullAccessTurnTupleSchema>;
export type RoutineFullAccessTuple = z.infer<typeof RoutineFullAccessTupleSchema>;
export type RoutineFullAccessProof = z.infer<typeof RoutineFullAccessProofSchema>;
/** Exact parsed request preimage, independent of the existing admission duplicate hash. */
export function routineFullAccessTurnRequestIdentity(input: CanonicalCreateChatTurnRequest): string {
  return JSON.stringify(CanonicalCreateChatTurnRequestSchema.parse(input));
}
