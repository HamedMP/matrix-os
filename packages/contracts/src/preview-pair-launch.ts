import { z } from "zod/v4";
import { PreviewPairActorSchema, PreviewPairDigestSchema, PreviewPairGenerationSchema, PreviewPairHandleSchema,
  PreviewPairIdSchema, PreviewPairManifestSchema, PreviewPairOrganizationSchema, PreviewPairOriginSchema,
  PreviewPairPrSchema, PreviewPairRoleSchema, PreviewPairShaSchema, previewPairHandle } from "./preview-pair.js";
import { PreviewPairControlOriginSchema } from "./preview-pair-control.js";
const Timestamp = z.iso.datetime({ offset: true }), Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const PreviewPairLaunchRequestSchema = z.strictObject({ role: PreviewPairRoleSchema,
  platform: z.enum(["darwin", "linux"]), arch: z.enum(["arm64", "x64"]) });
export const PreviewPairLaunchContextSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("collaboration-preview"),
  sourceOrigin: PreviewPairControlOriginSchema, pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema,
  role: PreviewPairRoleSchema, pr: PreviewPairPrSchema, sourceSha: PreviewPairShaSchema,
  actorId: PreviewPairActorSchema, machineId: z.uuid(), organizationId: PreviewPairOrganizationSchema,
  handle: PreviewPairHandleSchema, runtimeSlot: PreviewPairHandleSchema, authorityGeneration: Positive,
  apiOrigin: PreviewPairOriginSchema, browserOrigin: PreviewPairOriginSchema, identityIssuer: PreviewPairManifestSchema.shape.identityIssuer,
  platform: z.enum(["darwin", "linux"]), arch: z.enum(["arm64", "x64"]), artifactId: Positive, artifactSha256: PreviewPairDigestSchema,
  pairExpiresAt: Timestamp, fundingExpiresAt: Timestamp, issuedAt: Timestamp, verifyBefore: Timestamp, nonce: z.uuid() })
  .superRefine((value, ctx) => {
    const handle = previewPairHandle(value.pr, value.pairId, value.generation, value.role);
    if (value.handle !== handle || value.runtimeSlot !== handle || value.apiOrigin === value.browserOrigin
      || value.apiOrigin.replace("-api---", "-ui---") !== value.browserOrigin) ctx.addIssue({ code: "custom", message: "Invalid preview binding" });
    const issued = Date.parse(value.issuedAt), before = Date.parse(value.verifyBefore), pair = Date.parse(value.pairExpiresAt), funding = Date.parse(value.fundingExpiresAt);
    if (before <= issued || before - issued > 300_000 || before > pair || before > funding || funding > pair) {
      ctx.addIssue({ code: "custom", message: "Invalid verification lifetime" });
    }
  });
export const PreviewPairLaunchAttestationSchema = z.strictObject({ context: PreviewPairLaunchContextSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const PreviewPairLaunchVerificationSchema = z.strictObject({ valid: z.literal(true) });
export type PreviewPairLaunchContext = z.infer<typeof PreviewPairLaunchContextSchema>;
export type PreviewPairLaunchAttestation = z.infer<typeof PreviewPairLaunchAttestationSchema>;

export const PreviewPairProfileBindingSchema = z.strictObject({ pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema,
  sourceSha: PreviewPairShaSchema, role: PreviewPairRoleSchema, actorId: PreviewPairActorSchema, machineId: z.uuid(),
  organizationId: PreviewPairOrganizationSchema, authorityGeneration: Positive });
export type PreviewPairProfileBinding = z.infer<typeof PreviewPairProfileBindingSchema>;
