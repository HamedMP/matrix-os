import { createHash } from "node:crypto";
import { IsolatedChatEnvelopeSchema, type IsolatedChatEnvelope } from "@matrix-os/contracts";
import type { IsolatedChatIdentity } from "./isolated-chat-envelope.js";

export interface CanonicalPhaseReadinessOptions {
  identity?: () => IsolatedChatIdentity;
  now?: () => Date;
}

/** Internal server scope. No renderer parameter can enable it or weaken it. */
export function createCanonicalPhaseReadiness(config: IsolatedChatEnvelope | undefined, options: CanonicalPhaseReadinessOptions) {
  const phase = config ? IsolatedChatEnvelopeSchema.parse(config) : undefined;
  const canonical = phase?.target?.kind === "canonical_bot";
  const digest = phase ? createHash("sha256").update(JSON.stringify(phase)).digest("hex") : undefined;
  function observationScope(principal?: { userId: string }): "canonical_matrix" | undefined {
    if (!canonical) return undefined;
    const actual = options.identity?.(), at = (options.now?.() ?? new Date()).getTime();
    if (!actual || actual.ownerId !== phase!.ownerId || actual.machineId !== phase!.machineId
      || actual.runtimeSlot !== phase!.runtimeSlot || actual.runtimeTokenEpoch !== phase!.runtimeTokenEpoch
      || actual.credentialSha256 !== phase!.runtimeCredentialSha256 || actual.sourceSha !== phase!.sourceSha
      || principal && principal.userId !== phase!.ownerId
      || !Number.isFinite(at) || at < Date.parse(phase!.startsAt) || at >= Date.parse(phase!.expiresAt)) {
      throw new Error("Matrix AI route readiness unavailable");
    }
    return "canonical_matrix";
  }
  function requestHeaders(runtime: { identity: { ownerId: string; machineId: string; runtimeSlot: string }; runtimeAuthToken: string }): Record<string, string> {
    if (!canonical) return {};
    observationScope();
    if (runtime.identity.ownerId !== phase!.ownerId || runtime.identity.machineId !== phase!.machineId
      || runtime.identity.runtimeSlot !== phase!.runtimeSlot
      || createHash("sha256").update(runtime.runtimeAuthToken).digest("hex") !== phase!.runtimeCredentialSha256) {
      throw new Error("Matrix AI route readiness unavailable");
    }
    return { "x-matrix-isolated-chat-phase": phase!.phaseId, "x-matrix-isolated-chat-config": digest! };
  }
  return { observationScope, requestHeaders, digest, canonical };
}
