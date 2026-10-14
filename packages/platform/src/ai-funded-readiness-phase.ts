import { createHash } from "node:crypto";
import { JEV_MODEL_ID, type IsolatedChatEnvelope } from "@matrix-os/contracts";
import { timingSafeTokenEquals } from "./platform-token.js";

/** Runtime auth is established by the route before this private phase fence. */
export function fundedReadinessPhase(input: {
  phase?: IsolatedChatEnvelope; identity: { ownerId: string; machineId: string; runtimeSlot: string };
  runtimeTokenEpoch: number; runtimeToken: string; modelId?: typeof JEV_MODEL_ID;
  phaseHint?: string; configDigest?: string; now: Date;
}): boolean {
  const { phase, identity } = input;
  const canonical = phase?.target?.kind === "canonical_bot";
  const bound = phase !== undefined && phase.ownerId === identity.ownerId
    && phase.machineId === identity.machineId && phase.runtimeSlot === identity.runtimeSlot;
  const scopedCanonical = canonical && bound;
  const cacheOnly = bound && input.modelId !== JEV_MODEL_ID;
  const digest = phase ? createHash("sha256").update(JSON.stringify(phase)).digest("hex") : undefined;
  if (scopedCanonical && (!cacheOnly || input.phaseHint !== phase!.phaseId || !input.configDigest
    || !timingSafeTokenEquals(input.configDigest, digest!))
    || input.phaseHint !== undefined && (!cacheOnly || input.phaseHint !== phase!.phaseId)
    || input.configDigest !== undefined && (!scopedCanonical || !timingSafeTokenEquals(input.configDigest, digest!))) {
    throw new Error("Isolated Chat readiness unavailable");
  }
  if (cacheOnly) {
    const at = input.now.getTime();
    if (input.runtimeTokenEpoch !== phase!.runtimeTokenEpoch
      || createHash("sha256").update(input.runtimeToken).digest("hex") !== phase!.runtimeCredentialSha256
      || !Number.isFinite(at) || at < Date.parse(phase!.startsAt) || at >= Date.parse(phase!.expiresAt)) {
      throw new Error("Isolated Chat readiness unavailable");
    }
  }
  return cacheOnly;
}
