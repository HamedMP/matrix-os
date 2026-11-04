import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { parseLivePreviewPairManifest, PreviewPairManifestSchema } from "@matrix-os/contracts/preview-pair";
import { PreviewPairControlOriginSchema } from "@matrix-os/contracts/preview-pair-control";
import { PreviewPairLaunchContextSchema, PreviewPairLaunchAttestationSchema,
  PreviewPairLaunchRequestSchema } from "@matrix-os/contracts/preview-pair-launch";
const Input = PreviewPairLaunchRequestSchema.extend({ manifest: PreviewPairManifestSchema, sourceOrigin: PreviewPairControlOriginSchema });
const validSecret = (value: string) => typeof value === "string" && value.length >= 32 && value.length <= 4096;
function signature(context: unknown, secret: string) {
  const key = createHmac("sha256", secret).update("matrix-os:preview-pair:launch:v1").digest();
  return createHmac("sha256", key).update(JSON.stringify(context)).digest();
}
/** Non-authorizing proof only: no session, credential, directory or grant write. */
export function issuePreviewPairLaunch(raw: unknown, secret: string, now: number) {
  if (!validSecret(secret) || !Number.isFinite(now)) throw new Error("Preview launch is unavailable");
  const input = Input.parse(raw), manifest = parseLivePreviewPairManifest(input.manifest, now);
  const artifacts = manifest.desktopArtifacts.filter(item => item.platform === input.platform && item.arch === input.arch);
  if (artifacts.length !== 1) throw new Error("Preview launch is unavailable");
  const member = manifest.members[input.role], artifact = artifacts[0]!;
  const context = PreviewPairLaunchContextSchema.parse({ schemaVersion: 1, kind: "collaboration-preview",
    sourceOrigin: input.sourceOrigin, pairId: manifest.pairId, generation: manifest.generation, pr: manifest.pr, role: input.role,
    sourceSha: manifest.sourceSha, actorId: member.actorId, machineId: member.machineId, handle: member.handle, runtimeSlot: member.runtimeSlot,
    organizationId: manifest.organizationId, authorityGeneration: member.authorityGeneration, identityIssuer: manifest.identityIssuer,
    apiOrigin: manifest.apiOrigin, browserOrigin: manifest.browserOrigin, platform: input.platform, arch: input.arch,
    artifactId: artifact.artifactId, artifactSha256: artifact.sha256, pairExpiresAt: manifest.expiresAt, fundingExpiresAt: manifest.fundingExpiresAt,
    issuedAt: new Date(now).toISOString(), verifyBefore: new Date(Math.min(now + 300_000,
      Date.parse(manifest.expiresAt), Date.parse(manifest.fundingExpiresAt))).toISOString(), nonce: randomUUID() });
  return PreviewPairLaunchAttestationSchema.parse({ context, signature: signature(context, secret).toString("base64url") });
}
/** Cheap syntax/crypto checks precede the independent canonical-state lookup. */
export function verifyPreviewPairLaunch(raw: unknown, secret: string, now: number) {
  const parsed = PreviewPairLaunchAttestationSchema.safeParse(raw);
  if (!parsed.success || !validSecret(secret) || !Number.isFinite(now)) return null;
  const { context } = parsed.data;
  if (Date.parse(context.verifyBefore) <= now || Date.parse(context.issuedAt) > now + 5000) return null;
  const supplied = Buffer.from(parsed.data.signature, "base64url"), expected = signature(context, secret);
  if (supplied.length !== expected.length || supplied.toString("base64url") !== parsed.data.signature || !timingSafeEqual(supplied, expected)) return null;
  return context;
}
