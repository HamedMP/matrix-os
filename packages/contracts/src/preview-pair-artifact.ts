import { z } from "zod/v4";
const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const PreviewPairArtifactDownloadSchema = z.strictObject({ artifactId: Positive, runId: Positive,
  artifactName: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive().max(3 * 1024 ** 3) });
export const PreviewPairArtifactMetadataSchema = z.object({ id: Positive, name: z.string().max(128), expired: z.literal(false),
  size_in_bytes: Positive, digest: z.string().max(80), workflow_run: z.object({ id: Positive }) });
export const PreviewPairArtifactCredentialSchema = z.string().min(1).max(16_384);
export type PreviewPairArtifactDownloadIdentity = z.infer<typeof PreviewPairArtifactDownloadSchema>;

const Digest = z.string().regex(/^[a-f0-9]{64}$/), Sha = z.string().regex(/^[a-f0-9]{40}$/);
const File = z.object({ path: z.string().max(256), sha256: Digest, size: Positive });
export const PreviewPairHostReleaseSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("matrix-os-host-bundle"),
  version: z.string().max(128), channel: z.literal("none"), gitCommit: Sha,
  gitRef: z.string().max(128), buildTime: z.iso.datetime({ offset: true }) });
export const PreviewPairHostManifestSchema = PreviewPairHostReleaseSchema.extend({ severity: z.literal("normal"),
  updateType: z.literal("manual"), changelog: z.string().max(256), published: z.iso.datetime({ offset: true }),
  sha256: Digest, bundleSha256: Digest, size: Positive,
  files: z.object({ bundle: File, checksum: File, incrementalManifest: File }) });
export const PreviewPairIncrementalSchema = z.object({ manifestVersion: z.literal(1), version: z.string().max(128),
  objectRoot: z.literal("system-bundles/objects/sha256"), requiresFullBundle: z.literal(true),
  files: z.array(z.object({ type: z.literal("file"), sha256: Digest, size: z.number().int().nonnegative(),
    url: z.string().regex(/^system-bundles\/objects\/sha256\/[a-f0-9]{64}$/) })).max(50_000) });
export const PreviewPairArtifactPageSchema = z.object({ total_count: z.number().int().min(0).max(16),
  artifacts: z.array(PreviewPairArtifactMetadataSchema.extend({ expired: z.boolean(), workflow_run: z.object({ id: Positive }).optional() })).max(16) })
  .refine(value => value.total_count === value.artifacts.length, "Incomplete artifact observation");
