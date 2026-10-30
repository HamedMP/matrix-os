import { z } from "zod/v4";

export const PREVIEW_PAIR_MAX_LIFETIME_MS = 72 * 60 * 60 * 1_000;
export const PREVIEW_PAIR_MAX_MANIFEST_BYTES = 64 * 1_024;
export const PreviewPairRoleSchema = z.enum(["owner", "member"]);
export const PreviewPairIdSchema = z.uuid();
export const PreviewPairPrSchema = z.number().int().min(1).max(999_999_999);
export const PreviewPairGenerationSchema = z.number().int().min(1).max(999);
export const PreviewPairShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const PreviewPairDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const PreviewPairActorSchema = z.string().max(128).regex(/^user_[A-Za-z0-9_-]+$/);
export const PreviewPairOrganizationSchema = z.string().max(128).regex(/^org_[A-Za-z0-9_-]+$/);
export const PreviewPairHandleSchema = z.string().max(32).regex(/^cp-[1-9][0-9]{0,8}-[a-f0-9]{8}-[1-9][0-9]{0,2}-[ab]$/);
export const PreviewPairStateSchema = z.enum(["queued", "preparing", "ready", "updating", "failed", "cleanup_pending", "stopped"]);
const Timestamp = z.iso.datetime({ offset: true });
const Version = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);

/** Syntax only: the trusted controller must independently verify the exact tag/revision. */
export const PreviewPairOriginSchema = z.string().max(256).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password
      && /^cp-[a-f0-9]{8}-g[1-9][0-9]{0,2}-(?:ui|api)---matrix-platform-preview-[a-z0-9.-]+\.run\.app$/.test(url.hostname);
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}, "Invalid Preview origin");

const IdentityIssuer = z.string().max(256).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password
      && !url.port && /^[a-z0-9.-]+$/.test(url.hostname) && url.hostname.includes(".");
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}, "Invalid Preview identity issuer");

const ExecutablePath = z.string().min(1).max(512).refine(value =>
  !value.startsWith("/") && !/[\\\x00-\x1f:]/.test(value)
  && value.split("/").every(part => part !== "" && part !== "." && part !== ".."), "Invalid executable path");

export const PreviewPairDesktopArtifactSchema = z.strictObject({
  platform: z.enum(["darwin", "linux", "win32"]), arch: z.enum(["arm64", "x64"]),
  workflow: z.literal(".github/workflows/desktop-build.yml"),
  runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifactId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifactName: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  sourceSha: PreviewPairShaSchema, sha256: PreviewPairDigestSchema,
  sizeBytes: z.number().int().positive().max(3 * 1_024 ** 3),
  format: z.enum(["zip", "tar.gz"]), executableRelativePath: ExecutablePath,
});

export const PreviewPairMemberSchema = z.strictObject({
  role: PreviewPairRoleSchema, actorId: PreviewPairActorSchema, machineId: z.uuid(),
  handle: PreviewPairHandleSchema, runtimeSlot: PreviewPairHandleSchema,
  installedVersion: Version, runningVersion: Version,
  installedSha: PreviewPairShaSchema, runningSha: PreviewPairShaSchema,
  authorityGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lastControlAt: Timestamp,
});

const PlatformSource = z.strictObject({
  kind: z.enum(["candidate", "baseline"]), sha: PreviewPairShaSchema,
  compatibilityEvidence: z.string().min(1).max(256).optional(),
});

export function previewPairHandle(pr: number, pairId: string, generation: number, role: "owner" | "member"): string {
  PreviewPairPrSchema.parse(pr); PreviewPairIdSchema.parse(pairId);
  PreviewPairGenerationSchema.parse(generation); PreviewPairRoleSchema.parse(role);
  return PreviewPairHandleSchema.parse(`cp-${pr}-${pairId.slice(0, 8)}-${generation}-${role === "owner" ? "a" : "b"}`);
}

export function previewPairTag(pairId: string, generation: number, kind: "ui" | "api"): string {
  PreviewPairIdSchema.parse(pairId); PreviewPairGenerationSchema.parse(generation);
  z.enum(["ui", "api"]).parse(kind);
  return `cp-${pairId.slice(0, 8)}-g${generation}-${kind}`;
}

export const PreviewPairManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), repository: z.literal("HamedMP/matrix-os"),
  pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema, pr: PreviewPairPrSchema,
  sourceSha: PreviewPairShaSchema, state: z.literal("ready"), outdated: z.boolean(),
  createdAt: Timestamp, expiresAt: Timestamp, fundingExpiresAt: Timestamp,
  organizationId: PreviewPairOrganizationSchema, outsiderActorId: PreviewPairActorSchema,
  identityIssuer: IdentityIssuer, browserOrigin: PreviewPairOriginSchema, apiOrigin: PreviewPairOriginSchema,
  platformSource: PlatformSource, dataPolicy: z.literal("reset"),
  members: z.strictObject({ owner: PreviewPairMemberSchema, member: PreviewPairMemberSchema }),
  desktopArtifacts: z.array(PreviewPairDesktopArtifactSchema).min(1).max(8),
}).superRefine((manifest, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  const created = Date.parse(manifest.createdAt), expires = Date.parse(manifest.expiresAt);
  if (expires <= created || expires - created > PREVIEW_PAIR_MAX_LIFETIME_MS) invalid("Invalid pair lifetime");
  if (Date.parse(manifest.fundingExpiresAt) > expires) invalid("Funding outlives pair");
  if (manifest.browserOrigin === manifest.apiOrigin) invalid("Browser and API origins must differ");
  for (const kind of ["ui", "api"] as const) {
    const origin = kind === "ui" ? manifest.browserOrigin : manifest.apiOrigin;
    if (!origin.startsWith(`https://${previewPairTag(manifest.pairId, manifest.generation, kind)}---`)) invalid("Origin belongs to another pair generation");
  }
  if (new Set([manifest.members.owner.actorId, manifest.members.member.actorId, manifest.outsiderActorId]).size !== 3) invalid("Test actors must differ");
  if (manifest.members.owner.machineId === manifest.members.member.machineId) invalid("Test machines must differ");
  for (const role of ["owner", "member"] as const) {
    const member = manifest.members[role];
    const handle = previewPairHandle(manifest.pr, manifest.pairId, manifest.generation, role);
    if (member.role !== role || member.handle !== handle || member.runtimeSlot !== handle) invalid("Member binding mismatch");
    if (member.installedSha !== manifest.sourceSha || member.runningSha !== manifest.sourceSha
      || member.installedVersion !== member.runningVersion) invalid("Member source mismatch");
  }
  if (manifest.platformSource.kind === "candidate" && manifest.platformSource.sha !== manifest.sourceSha) invalid("Platform source mismatch");
  if (manifest.platformSource.kind === "baseline" && !manifest.platformSource.compatibilityEvidence) invalid("Baseline compatibility evidence required");
  const targets = new Set<string>();
  for (const artifact of manifest.desktopArtifacts) {
    const target = `${artifact.platform}/${artifact.arch}`;
    if (targets.has(target) || artifact.sourceSha !== manifest.sourceSha) invalid("Desktop target/source mismatch");
    targets.add(target);
  }
});

export class PreviewPairContractError extends Error {
  constructor() { super("Preview pair is unavailable"); this.name = "PreviewPairContractError"; }
}

export function parseLivePreviewPairManifest(input: unknown, now = Date.now()): PreviewPairManifest {
  let decoded: unknown = input;
  if (typeof input === "string") {
    if (input.length > PREVIEW_PAIR_MAX_MANIFEST_BYTES
      || new TextEncoder().encode(input).byteLength > PREVIEW_PAIR_MAX_MANIFEST_BYTES) throw new PreviewPairContractError();
    try { decoded = JSON.parse(input); }
    catch (error: unknown) { if (error instanceof SyntaxError) throw new PreviewPairContractError(); throw error; }
  }
  const parsed = PreviewPairManifestSchema.safeParse(decoded);
  if (!parsed.success || !Number.isFinite(now)) throw new PreviewPairContractError();
  const manifest = parsed.data;
  if (Date.parse(manifest.createdAt) > now + 30_000 || Date.parse(manifest.expiresAt) <= now
    || Date.parse(manifest.fundingExpiresAt) <= now) throw new PreviewPairContractError();
  for (const member of Object.values(manifest.members)) {
    const lastControl = Date.parse(member.lastControlAt);
    if (now - lastControl > 60_000 || lastControl > now + 30_000) throw new PreviewPairContractError();
  }
  return manifest;
}

export type PreviewPairManifest = z.infer<typeof PreviewPairManifestSchema>;
export type PreviewPairMember = z.infer<typeof PreviewPairMemberSchema>;
export type PreviewPairDesktopArtifact = z.infer<typeof PreviewPairDesktopArtifactSchema>;
export type PreviewPairRole = z.infer<typeof PreviewPairRoleSchema>;
export type PreviewPairState = z.infer<typeof PreviewPairStateSchema>;
