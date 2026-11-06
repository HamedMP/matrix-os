import { CanonicalChatIdSchema, CanonicalChatRequestIdSchema } from "#canonical-chat";
import { BotInteractionIdSchema, BotBaseRevisionSchema } from "#bots/ids";
import { z } from 'zod/v4';

export const ROUTINE_ORIGIN_PROOF_HEADER = 'x-matrix-routine-origin-proof';
export const ROUTINE_CREATION_PROOF_HEADER = 'x-matrix-routine-creation-proof';
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RoutineOriginDecisionSubmitSchema = z.strictObject({
  kind: z.literal('approval'), baseRevision: BotBaseRevisionSchema,
  decision: z.enum(['approve', 'deny']),
});
const common = {
  handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), runtimeSlot: ref, machineId: ref, ownerId: ref,
  sourceChatId: CanonicalChatIdSchema, method: z.literal('POST'), path: z.string().min(1).max(512), bodyDigest: digest,
};
export const RoutineOriginApprovalTupleSchema = RoutineOriginDecisionSubmitSchema.extend({
  ...common, purpose: z.literal('routine_origin_approval'), interactionId: BotInteractionIdSchema,
}).refine(value => value.path === `/api/chats/${value.sourceChatId}/routine-origin/${value.interactionId}/resolve`);
export const RoutineCreationRouteTupleSchema = z.strictObject({
  ...common, purpose: z.literal('routine_creation_route'), routineCreation: z.literal('matrix'),
  clientRequestId: CanonicalChatRequestIdSchema, baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).refine(value => [`/api/chats/${value.sourceChatId}/turns`, `/api/chats/${value.sourceChatId}/queued-turns`].includes(value.path));
const proof = { version: z.literal(1), sessionId: ref, issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(), nonce: z.string().regex(/^[a-f0-9]{32}$/) };
export const RoutineOriginApprovalProofSchema = RoutineOriginApprovalTupleSchema.safeExtend(proof);
export const RoutineCreationRouteProofSchema = RoutineCreationRouteTupleSchema.safeExtend(proof);
export const RoutineBrowserTupleSchema = z.union([RoutineOriginApprovalTupleSchema, RoutineCreationRouteTupleSchema]);
export const RoutineBrowserProofSchema = z.union([RoutineOriginApprovalProofSchema, RoutineCreationRouteProofSchema]);
export type RoutineOriginDecisionSubmit = z.infer<typeof RoutineOriginDecisionSubmitSchema>;
export type RoutineOriginApprovalTuple = z.infer<typeof RoutineOriginApprovalTupleSchema>;
export type RoutineOriginApprovalProof = z.infer<typeof RoutineOriginApprovalProofSchema>;
export type RoutineCreationRouteTuple = z.infer<typeof RoutineCreationRouteTupleSchema>;
export type RoutineCreationRouteProof = z.infer<typeof RoutineCreationRouteProofSchema>;
export type RoutineBrowserTuple = z.infer<typeof RoutineBrowserTupleSchema>;
export type RoutineBrowserProof = z.infer<typeof RoutineBrowserProofSchema>;
