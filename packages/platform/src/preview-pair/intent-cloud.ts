import { sql } from "kysely";
import { PreviewPairDigestSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import { createPreviewPairCloudRetirement, type PreviewPairCloudRetirementOptions } from "./cloud-retirement.js";
import { createPreviewPairOperationReader } from "./publication-operations.js";
import { withPreviewPairIntentClaim, type PreviewPairIntentRetirement } from "./intent-recovery.js";
import { PreviewPairConflictError } from "./repository.js";

export function createPreviewPairIntentCloudCleanup(options: PreviewPairCloudRetirementOptions & {
  db: PlatformDB; profileFingerprint: string; now: () => number;
}): PreviewPairIntentRetirement {
  PreviewPairDigestSchema.parse(options.profileFingerprint);
  const retire = createPreviewPairCloudRetirement(options), operations = createPreviewPairOperationReader(options);
  return async (expected, claim, signal) => {
    const canonical = () => withPreviewPairIntentClaim(options.db, claim, options.now(), async (_trx, row) => {
      if (row.state !== "cleanup_pending" || row.profile_fingerprint !== options.profileFingerprint
        || row.pair_id !== expected.pair_id || row.generation !== expected.generation || row.source_sha !== expected.source_sha
        || row.controller_run_id !== expected.controller_run_id || row.publication_id !== expected.publication_id) throw new PreviewPairConflictError();
      return row;
    });
    const row = await canonical(); signal.throwIfAborted();
    // The source publisher must claim before issuing its single cloud mutation.
    // Pending/stopped intents cannot claim: an unissued request has no side effect.
    if (row.publication_state === "unissued") return true;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    if (row.publication_state === "issuing") {
      const found = await operations.discover(row, deadline);
      if (!found) return false;
      const name = found.name;
      await withPreviewPairIntentClaim(options.db, claim, options.now(), async (trx, current) => {
        if (current.state !== "cleanup_pending" || current.publication_state !== "issuing"
          || current.publication_id !== row.publication_id || current.profile_fingerprint !== options.profileFingerprint) throw new PreviewPairConflictError();
        await trx.executor.updateTable("preview_pair_cloud_intents").set({ publication_state: "accepted", operation_name: name,
          revision: sql`revision + 1`, claim_id: null, claim_expires_at: null, next_attempt_at: new Date(options.now()).toISOString() })
          .where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation).where("revision", "=", claim.revision)
          .where("claim_id", "=", claim.claimId).where("publication_state", "=", "issuing").returning("pair_id").executeTakeFirstOrThrow();
      });
      return false; // Resume under a fresh claim after recovering the receipt.
    }
    if (row.publication_state === "accepted") {
      const operation = await operations.read(row, deadline);
      if (!operation || operation.done !== true) return false;
    }
    await canonical();
    return retire(async () => {
      const fresh = await canonical();
      return { pairId: fresh.pair_id, generation: fresh.generation, sourceSha: fresh.source_sha };
    }, deadline);
  };
}
