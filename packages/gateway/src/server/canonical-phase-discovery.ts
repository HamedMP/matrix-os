import { createHash } from "node:crypto";
import { parseIsolatedChatEnvelope } from "@matrix-os/contracts";
import type { FundedAiRuntimeConfig } from "../funded-ai-credential-manager.js";
import { createCanonicalPhaseReadiness } from "../chat/canonical-phase-readiness.js";
import { readReleaseInfo } from "../system-info.js";

/** Composition only: current host facts, never renderer selection or saved SOUL. */
export function createCanonicalPhaseDiscovery(config: FundedAiRuntimeConfig | undefined, ownerId: string | undefined, options: { env?: NodeJS.ProcessEnv; sourceSha?: () => string; now?: () => Date } = {}) {
  const env = options.env ?? process.env;
  const routeOptions = { now: options.now, identity: () => ({ ownerId: ownerId ?? "", machineId: env.MATRIX_MACHINE_ID ?? "",
    runtimeSlot: env.MATRIX_RUNTIME_SLOT ?? "", runtimeTokenEpoch: Number(env.MATRIX_RUNTIME_TOKEN_EPOCH),
    credentialSha256: createHash("sha256").update(env.MATRIX_FUNDED_AI_RUNTIME_TOKEN ?? "").digest("hex"),
    sourceSha: options.sourceSha?.() ?? readReleaseInfo()?.gitCommit ?? env.MATRIX_BUILD_SHA ?? "" }) };
  return { routeOptions, ...createCanonicalPhaseReadiness(config?.isolatedChat ?? parseIsolatedChatEnvelope(env.MATRIX_ISOLATED_CHAT_ENVELOPE), routeOptions) };
}
