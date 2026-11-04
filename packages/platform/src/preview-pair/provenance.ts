import { z } from "zod/v4";
import { PreviewPairDesktopArtifactSchema, PreviewPairDigestSchema, PreviewPairGenerationSchema,
  PreviewPairIdSchema, PreviewPairManifestSchema, PreviewPairOriginSchema, PreviewPairPrSchema,
  PreviewPairShaSchema, previewPairTag } from "@matrix-os/contracts/preview-pair";
import type { EnabledPreviewPairConfig } from "./config.js";

export const PreviewPairCandidateSchema = z.strictObject({
  sourceSha: PreviewPairShaSchema,
  hostBundleVersion: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  hostBundleSha256: PreviewPairDigestSchema,
  desktopArtifacts: z.array(PreviewPairDesktopArtifactSchema).min(1).max(8),
  browserOrigin: PreviewPairOriginSchema, apiOrigin: PreviewPairOriginSchema,
  identityIssuer: PreviewPairManifestSchema.shape.identityIssuer,
  platformSource: PreviewPairManifestSchema.shape.platformSource,
});
export type PreviewPairCandidate = z.infer<typeof PreviewPairCandidateSchema>;
const Expected = z.strictObject({ pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema,
  pr: PreviewPairPrSchema, sourceSha: PreviewPairShaSchema });
const Repo = z.object({ full_name: z.literal("HamedMP/matrix-os") });
const Pull = z.object({ number: PreviewPairPrSchema, state: z.literal("open"),
  head: z.object({ sha: PreviewPairShaSchema, repo: Repo }), base: z.object({ repo: Repo }) });
const Release = z.object({ release: z.object({ version: z.string(), channel: z.null(),
  gitCommit: PreviewPairShaSchema, sourcePr: PreviewPairPrSchema, sha256: PreviewPairDigestSchema }), promotedChannels: z.array(z.string()).length(0) });
const Artifact = z.object({ id: z.number().int().positive(), name: z.string(), digest: z.string(),
  size_in_bytes: z.number().int().positive(), expired: z.literal(false), workflow_run: z.object({ id: z.number().int().positive() }) });
const Build = z.object({ id: z.number().int().positive(), status: z.literal("completed"), conclusion: z.literal("success"),
  event: z.literal("workflow_dispatch"), path: z.string(), head_sha: PreviewPairShaSchema, repository: Repo, head_repository: Repo });
const Receipt = z.strictObject({ runId: z.number().int().positive(), artifactId: z.number().int().positive(), sourceSha: PreviewPairShaSchema, workflowSha: PreviewPairShaSchema });
const Controller = z.object({ controllerSha: PreviewPairShaSchema, executionSha: PreviewPairShaSchema,
  workflowPath: z.string().max(128), treeSha: PreviewPairShaSchema });
const Authority = z.object({ browserOrigin: PreviewPairOriginSchema, apiOrigin: PreviewPairOriginSchema,
  identityIssuer: z.string().max(256), sourceSha: PreviewPairShaSchema, serviceAccount: z.string().max(128),
  clerkSecretRef: z.string().max(96), databaseSecretRef: z.string().max(96), ticketKeysSecretRef: z.string().max(96),
  appDomainHosts: z.array(z.string().max(256)).min(1).max(8), browserRevision: z.string().min(1).max(128),
  apiRevision: z.string().min(1).max(128), observedAt: z.iso.datetime({ offset: true }) });

/** These readers are authenticated provider/controller adapters, never request-body claims. */
export interface PreviewPairProvenanceSource {
  pullRequest(pr: number): Promise<unknown>;
  hostRelease(version: string): Promise<unknown>;
  artifact(id: number): Promise<unknown>;
  build(runId: number): Promise<unknown>;
  buildSource(runId: number, artifactId: number): Promise<unknown>;
  controllerProof(runId: number): Promise<unknown>;
  authority(browserOrigin: string, apiOrigin: string): Promise<unknown>;
}
export class PreviewPairProvenanceError extends Error {
  constructor() { super("Preview candidate is unavailable"); this.name = "PreviewPairProvenanceError"; }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PreviewPairProvenanceError();
  return result.data;
}
function requireProof(value: boolean): void { if (!value) throw new PreviewPairProvenanceError(); }
async function bounded<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PreviewPairProvenanceError()), 10_000);
      timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Validate canonical release/CI/runtime observations before any machine preparation. */
export async function verifyPreviewPairCandidate(input: unknown, expectedInput: unknown,
  source: PreviewPairProvenanceSource, config: EnabledPreviewPairConfig, now: number): Promise<PreviewPairCandidate> {
  const candidate = parse(PreviewPairCandidateSchema, input), expected = parse(Expected, expectedInput);
  requireProof(candidate.sourceSha === expected.sourceSha && Number.isFinite(now));
  requireProof(candidate.identityIssuer === config.identityIssuer && candidate.browserOrigin !== candidate.apiOrigin);
  for (const kind of ["ui", "api"] as const) {
    const origin = kind === "ui" ? candidate.browserOrigin : candidate.apiOrigin;
    requireProof(origin.startsWith(`https://${previewPairTag(expected.pairId, expected.generation, kind)}---`));
  }
  requireProof(candidate.platformSource.kind === "candidate" ? candidate.platformSource.sha === expected.sourceSha
    : Boolean(candidate.platformSource.compatibilityEvidence));
  try {
    const [rawPull, rawRelease, rawAuthority] = await Promise.all([
      bounded(() => source.pullRequest(expected.pr)), bounded(() => source.hostRelease(candidate.hostBundleVersion)),
      bounded(() => source.authority(candidate.browserOrigin, candidate.apiOrigin)),
    ]);
    const pull = parse(Pull, rawPull), { release } = parse(Release, rawRelease), authority = parse(Authority, rawAuthority);
    requireProof(pull.number === expected.pr && pull.head.sha === expected.sourceSha);
    requireProof(release.version === candidate.hostBundleVersion && release.gitCommit === expected.sourceSha
      && release.sourcePr === expected.pr && release.sha256 === candidate.hostBundleSha256);
    requireProof(authority.browserOrigin === candidate.browserOrigin && authority.apiOrigin === candidate.apiOrigin
      && authority.sourceSha === candidate.platformSource.sha && authority.identityIssuer === config.identityIssuer
      && authority.serviceAccount === config.serviceAccount && authority.clerkSecretRef === config.clerkSecretRef
      && authority.databaseSecretRef === config.databaseSecretRef && authority.ticketKeysSecretRef === config.ticketKeysSecretRef
      && authority.browserRevision === authority.apiRevision);
    const observed = Date.parse(authority.observedAt);
    requireProof(now - observed <= 300_000 && observed <= now + 30_000
      && authority.appDomainHosts.includes(new URL(candidate.browserOrigin).hostname)
      && !authority.appDomainHosts.includes(new URL(candidate.apiOrigin).hostname));
    const targets = new Set<string>(); // At most eight validated artifact entries.
    for (const item of candidate.desktopArtifacts) {
      const key = `${item.platform}/${item.arch}`;
      requireProof(!targets.has(key) && item.sourceSha === expected.sourceSha); targets.add(key);
    }
    await Promise.all(candidate.desktopArtifacts.map(async item => {
      const [rawArtifact, rawBuild, rawReceipt, rawController] = await Promise.all([
        bounded(() => source.artifact(item.artifactId)), bounded(() => source.build(item.runId)),
        bounded(() => source.buildSource(item.runId, item.artifactId)), bounded(() => source.controllerProof(item.runId)),
      ]);
      const artifact = parse(Artifact, rawArtifact), build = parse(Build, rawBuild);
      const receipt = parse(Receipt, rawReceipt), controller = parse(Controller, rawController);
      requireProof(artifact.id === item.artifactId && artifact.name === item.artifactName
        && artifact.digest === `sha256:${item.sha256}` && artifact.size_in_bytes === item.sizeBytes
        && artifact.workflow_run.id === item.runId && build.id === item.runId && build.path === item.workflow
        && receipt.runId === item.runId && receipt.artifactId === item.artifactId
        && receipt.sourceSha === expected.sourceSha && receipt.workflowSha === build.head_sha
        && controller.controllerSha === config.reviewedControllerSha && controller.executionSha === build.head_sha
        && controller.workflowPath === item.workflow);
    }));
    return candidate;
  } catch (error: unknown) {
    if (error instanceof PreviewPairProvenanceError) throw error;
    console.warn("[preview-pair] provenance unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new PreviewPairProvenanceError();
  }
}
