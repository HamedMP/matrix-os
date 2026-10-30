import type { PlatformDB } from "../db.js";
import type { HetznerClient } from "../customer-vps-hetzner.js";
import type { PreviewPairClaim } from "./lifecycle.js";
import type { PreviewPairCleanupAdapters, PreviewPairCleanupMember } from "./cleanup.js";
import { PreviewPairConflictError } from "./repository.js";
import { createPreviewPairProviderCleanup } from "./cleanup-provider.js";
import { retirePreviewPairProjection } from "./projection.js";
import { previewPairOperation } from "./operation.js";
import { PreviewPairUpstreamError } from "./http.js";

/** Independent retirement effects all run; capacity remains held until every
 * boundary confirms retirement and the established provider proof succeeds. */
export function createPreviewPairCleanup(options: { db: PlatformDB; target: PlatformDB; provider: HetznerClient;
  retireCloud(member: PreviewPairCleanupMember, claim: PreviewPairClaim, signal: AbortSignal): Promise<boolean>;
  now: () => number;
}): PreviewPairCleanupAdapters {
  if (typeof options.retireCloud !== "function") throw new PreviewPairConflictError();
  const provider = createPreviewPairProviderCleanup(options.db, options.provider, options.now);
  return {
    async retire(member, claim) {
      const attempts = await Promise.allSettled([
        provider.retire(member, claim),
        retirePreviewPairProjection(options.db, options.target, member, claim, options.now),
        previewPairOperation(signal => options.retireCloud(member, claim, signal)),
      ]);
      let pending = false;
      for (const [index, attempt] of attempts.entries()) {
        if (attempt.status === "rejected" || index === 2 && attempt.value !== true) {
          pending = true;
          console.warn("[preview-pair] retirement pending", ["provider", "projection", "cloud"][index], member.pairId, member.generation);
        }
      }
      if (pending) throw new PreviewPairUpstreamError();
    },
    proveAbsent: provider.proveAbsent,
  };
}
