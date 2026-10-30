import type { PlatformDB } from "../db.js";
import { readActivePreviewRuntimeAccess } from "../preview-runtime-access.js";
import { readCheckoutFundingSnapshot } from "../ai-funded-checkout-snapshot.js";
import type { PreviewPairReadinessMember } from "./readiness.js";
import { PreviewPairConflictError } from "./repository.js";
import { readCanonicalPreviewPairMember } from "./runtime-binding.js";

/** Current spendable test credit, never initial allocation size or an auto-refill.
 * Funding stays on the trusted control ledger; candidate code gets no bank key.
 * Host verification is a required internal port; production must bind both actual
 * host configuration revisions, not a UI-selected model or a caller assertion. */
export function createPreviewPairFundingReader(options: {
  db: PlatformDB; now: () => number;
  hostConfiguration: (member: PreviewPairReadinessMember, signal: AbortSignal) => Promise<boolean>;
}) {
  if (typeof options.hostConfiguration !== "function") throw new PreviewPairConflictError();
  return async (member: PreviewPairReadinessMember, signal: AbortSignal): Promise<unknown> => {
    try {
      signal.throwIfAborted();
      await readCanonicalPreviewPairMember(options.db, member, options.now);
      const identity = { ownerId: member.actorId, machineId: member.machineId, runtimeSlot: member.handle };
      const checked = new Date(options.now());
      const allocation = await readActivePreviewRuntimeAccess(options.db, identity, checked);
      if (!allocation || allocation.identity.runtimeTokenEpoch !== member.tokenEpoch || allocation.ai.requestsRemaining <= 0) throw new PreviewPairConflictError();
      const snapshot = await readCheckoutFundingSnapshot({ db: options.db, identity, checked, policyFreshnessMs: 15_000,
        deadlineAtMs: Date.now() + 10_000, includeChatAvailability: true, projectExpiredCredit: true });
      const remainingMicrousd = Math.min(snapshot.chatAvailability?.availableBalanceMicrousd ?? 0,
        snapshot.funding.remainingBalanceMicrousd, snapshot.funding.remainingBudgetMicrousd);
      if (!snapshot.policy.enabled || !Number.isSafeInteger(remainingMicrousd) || remainingMicrousd <= 0) throw new PreviewPairConflictError();
      signal.throwIfAborted();
      if (!await options.hostConfiguration(member, signal)) throw new PreviewPairConflictError();
      signal.throwIfAborted();
      await readCanonicalPreviewPairMember(options.db, member, options.now);
      return { source: "preview-test", machineId: member.machineId, actorId: member.actorId,
        tokenEpoch: member.tokenEpoch, remainingMicrousd, expiresAt: allocation.expiresAt };
    } catch (error: unknown) {
      console.warn("[preview-pair] funding observation unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new PreviewPairConflictError();
    }
  };
}
