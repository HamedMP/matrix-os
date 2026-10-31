import { z } from "zod/v4";
const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const PreviewPairArtifactDownloadSchema = z.strictObject({ artifactId: Positive, runId: Positive,
  artifactName: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive().max(3 * 1024 ** 3) });
export const PreviewPairArtifactMetadataSchema = z.object({ id: Positive, name: z.string().max(128), expired: z.literal(false),
  size_in_bytes: Positive, digest: z.string().max(80), workflow_run: z.object({ id: Positive }) });
export const PreviewPairArtifactCredentialSchema = z.string().min(1).max(16_384);
export type PreviewPairArtifactDownloadIdentity = z.infer<typeof PreviewPairArtifactDownloadSchema>;
