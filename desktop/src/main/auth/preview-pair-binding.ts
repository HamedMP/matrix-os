import { PreviewPairProfileBindingSchema, type PreviewPairProfileBinding } from "@matrix-os/contracts/preview-pair-launch";
import type { VerifiedDesktopPreviewContext } from "../preview-pair-context";
import type { ConnectionProfile } from "./auth-service";
import type { StoredCredential } from "./credential-store";
export class PreviewPairAuthMismatch extends Error {
  constructor(role: "owner" | "member") { super(`Sign in with the preview ${role} account.`); this.name = "PreviewPairAuthMismatch"; }
}
export function previewPairProfileBinding(context: VerifiedDesktopPreviewContext): PreviewPairProfileBinding {
  const { pairId, generation, sourceSha, role, actorId, machineId, organizationId, authorityGeneration } = context;
  return PreviewPairProfileBindingSchema.parse({ pairId, generation, sourceSha, role, actorId, machineId, organizationId, authorityGeneration });
}
export function previewPairContextExpired(context: VerifiedDesktopPreviewContext, now: number) {
  return !Number.isFinite(now) || Date.parse(context.pairExpiresAt) <= now || Date.parse(context.fundingExpiresAt) <= now;
}
export function assertPreviewPairCredential(context: VerifiedDesktopPreviewContext, credential: StoredCredential, slot: string, now: number) {
  if (previewPairContextExpired(context, now) || credential.userId !== context.actorId || credential.handle !== context.handle
    || slot !== context.runtimeSlot || credential.expiresAt <= now + 30_000) throw new PreviewPairAuthMismatch(context.role);
}
export function matchesPreviewPairCache(context: VerifiedDesktopPreviewContext, credential: StoredCredential | null, profile: ConnectionProfile | null, now: number) {
  if (!credential || !profile || previewPairContextExpired(context, now) || credential.userId !== context.actorId || credential.handle !== context.handle
    || profile.userId !== context.actorId || profile.handle !== context.handle || profile.platformHost !== context.apiOrigin || profile.runtimeSlot !== context.runtimeSlot) return false;
  const binding = PreviewPairProfileBindingSchema.safeParse(profile.previewPair);
  if (!binding.success) return false;
  const expected = previewPairProfileBinding(context);
  return (Object.keys(expected) as Array<keyof PreviewPairProfileBinding>).every(key => binding.data[key] === expected[key]);
}
