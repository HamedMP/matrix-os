import type { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { claimPreviewPair } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { refreshPreviewPairReadiness, type PreviewPairReadinessAdapters } from "../../packages/platform/src/preview-pair/readiness.js";

/** Synthetic host/identity/funding observations; real ledger, claims and readiness producer. */
export function previewPairReadinessAdapters(fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>): PreviewPairReadinessAdapters {
  return {
    authority: async () => true,
    membership: async actor => actor !== fixture.manifest.outsiderActorId,
    observe: async member => ({ ...fixture.manifest.members[member.role], machineId: member.machineId,
      actorId: member.actorId, healthy: true, bundleSha256: fixture.candidate.hostBundleSha256,
      observedAt: new Date(PAIR_NOW).toISOString() }),
    funding: async member => ({ source: "preview-test", machineId: member.machineId, actorId: member.actorId,
      tokenEpoch: member.tokenEpoch, remainingMicrousd: 1_000_000, expiresAt: fixture.manifest.fundingExpiresAt }),
  };
}
export async function readyPreviewPair(fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>) {
  await fixture.db.executor.updateTable("user_machines").set({ status: "running" }).execute();
  const adapters = previewPairReadinessAdapters(fixture);
  const claim = await claimPreviewPair(fixture.db, fixture.pair.pair_id, 1, 1, PAIR_NOW);
  return refreshPreviewPairReadiness(fixture.db, claim, fixture.config, adapters, () => PAIR_NOW);
}
