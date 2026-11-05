import { sql } from "kysely";
import type { z } from "zod/v4";
import type { PlatformDB } from "../db.js";
import type { PreviewPairUpdateAdoptionSchema } from "./api-contracts.js";
import { PreviewPairCandidateSchema } from "./provenance.js";
import { PreviewPairConflictError } from "./repository.js";
import { adoptPreviewPairCloudIntent } from "./cloud-intents.js";
import { requestPreviewPairUpdate } from "./update.js";

/** Provenance and current membership must be verified before this DB-only
 * transition. Progress revisions may advance during a protected build; the
 * selected parent generation/source remain immutable user intent. */
export async function adoptPublishedPreviewPairUpdate(db: PlatformDB, pairId: string,
  input: z.infer<typeof PreviewPairUpdateAdoptionSchema>, requesterId: string, now: number) {
  return db.transaction(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('preview-pair-admission', 0))`.execute(trx.executor);
    const pair = await trx.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", pairId).forUpdate().executeTakeFirst();
    const base = await trx.executor.selectFrom("preview_pair_generations").select("source_sha").where("pair_id", "=", pairId)
      .where("generation", "=", input.baseGeneration).executeTakeFirst();
    if (!pair || base?.source_sha !== input.baseSourceSha || !input.candidate.sourceProfileFingerprint) throw new PreviewPairConflictError();
    const target = input.baseGeneration + 1;
    if (pair.state === "updating" && pair.generation === input.baseGeneration
      || pair.generation === target && pair.state !== "updating") {
      const saved = await trx.executor.selectFrom("preview_pair_generations").selectAll()
        .where("pair_id", "=", pairId).where("generation", "=", target).executeTakeFirst();
      if (!saved || saved.source_sha !== input.candidate.sourceSha || saved.controller_run_id !== String(input.controllerRunId)
        || JSON.stringify(PreviewPairCandidateSchema.parse(saved.candidate)) !== JSON.stringify(input.candidate)) throw new PreviewPairConflictError();
      await adoptPreviewPairCloudIntent(trx, { pairId, generation: target, pr: pair.pr, requesterId,
        sourceSha: input.candidate.sourceSha, controllerRunId: input.controllerRunId,
        profileFingerprint: input.candidate.sourceProfileFingerprint }, now);
      return pair; // Exact adopted replay, never another reset or allowance.
    }
    if (pair.generation !== input.baseGeneration || pair.source_sha !== input.baseSourceSha) throw new PreviewPairConflictError();
    // The existing writer still enforces revision in SQL, with the row locked
    // across this read/write. No external call can extend this transaction.
    return requestPreviewPairUpdate(trx, pairId, pair.generation, pair.revision, input.candidate, now, input.controllerRunId, requesterId);
  });
}
