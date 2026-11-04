import { z } from "zod/v4";
import { PreviewPairIdSchema, PreviewPairPrSchema, PreviewPairShaSchema, PreviewPairGenerationSchema, PreviewPairDigestSchema } from "@matrix-os/contracts/preview-pair";
import { PreviewPairCandidateSchema } from "./provenance.js";
import { PreviewPairFailureStageSchema } from "@matrix-os/contracts/preview-pair-control";
export { PreviewPairFailureStageSchema };
export type PreviewPairFailureStage = z.infer<typeof PreviewPairFailureStageSchema>;

const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const PreviewPairGenerationPathSchema = z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(PreviewPairGenerationSchema);
export const PreviewPairPrepareRequestSchema = z.strictObject({ repository: z.literal("HamedMP/matrix-os"),
  pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema, pr: PreviewPairPrSchema,
  sourceSha: PreviewPairShaSchema, controllerRunId: Revision });
export const PreviewPairRequestStopSchema = z.strictObject({ type: z.literal("stop"),
  generation: PreviewPairGenerationSchema, controllerRunId: Revision });
export const PreviewPairPublishSchema = z.strictObject({ generation: PreviewPairGenerationSchema,
  controllerRunId: Revision, imageSha256: PreviewPairDigestSchema });
export const PreviewPairControllerStatusSchema = z.strictObject({ generation: PreviewPairGenerationSchema, controllerRunId: Revision });
export const PreviewPairStartSchema = z.strictObject({ repository: z.literal("HamedMP/matrix-os"),
  pairId: PreviewPairIdSchema, pr: PreviewPairPrSchema, sourceSha: PreviewPairShaSchema,
  controllerRunId: Revision, candidate: PreviewPairCandidateSchema });
const Fence = { generation: PreviewPairGenerationSchema, revision: Revision };
export const PreviewPairReaderStopSchema = z.strictObject(Fence);
export const PreviewPairUpdateAdoptionSchema = z.strictObject({ baseGeneration: z.number().int().min(1).max(998),
  baseSourceSha: PreviewPairShaSchema, controllerRunId: Revision, candidate: PreviewPairCandidateSchema });
export const PreviewPairActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("stop"), ...Fence }),
  z.strictObject({ type: z.literal("update"), ...Fence, dataPolicy: z.literal("reset"),
    controllerRunId: Revision, candidate: PreviewPairCandidateSchema }),
  z.strictObject({ type: z.literal("reconcile"), ...Fence }),
]);
export const PreviewPairReconcileSchema = z.strictObject({ limit: z.number().int().min(1).max(16).default(16) });
export const PreviewPairListSchema = z.strictObject({ cursor: PreviewPairIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(16).default(16) });
export type PreviewPairStartRequest = z.infer<typeof PreviewPairStartSchema>;
export type PreviewPairActionRequest = z.infer<typeof PreviewPairActionSchema>;
