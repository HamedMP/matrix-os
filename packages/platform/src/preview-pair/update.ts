import { sql } from "kysely";
import { z } from "zod/v4";
import { PreviewPairGenerationSchema, PreviewPairIdSchema, previewPairTag } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import { PreviewPairCandidateSchema } from "./provenance.js";
import { PreviewPairConflictError, prepareLeasedPairMembers, type PreparePairMember } from "./repository.js";
import { withPreviewPairClaim, type PreviewPairClaim } from "./lifecycle.js";

/** Candidate provenance is verified independently before this DB-only transition. */
export async function requestPreviewPairUpdate(db: PlatformDB, pairId: string, generation: number,
  revision: number, rawCandidate: unknown, now: number) {
  PreviewPairIdSchema.parse(pairId); PreviewPairGenerationSchema.parse(generation);
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(revision);
  const candidate = PreviewPairCandidateSchema.parse(rawCandidate);
  if (!Number.isFinite(now) || generation >= 999) throw new PreviewPairConflictError();
  for (const kind of ["ui", "api"] as const) {
    const origin = kind === "ui" ? candidate.browserOrigin : candidate.apiOrigin;
    if (!origin.startsWith(`https://${previewPairTag(pairId, generation + 1, kind)}---`)) throw new PreviewPairConflictError();
  }
  return db.transaction(async trx => {
    const row = await trx.executor.updateTable("preview_pairs").set({ state: "updating", requested_source_sha: candidate.sourceSha, outdated: false,
      revision: sql`revision + 1`, claim_id: null, claim_expires_at: null, next_attempt_at: new Date(now).toISOString() })
      .where("pair_id", "=", pairId).where("generation", "=", generation).where("revision", "=", revision)
      .where("expires_at", ">", new Date(now).toISOString()).where("state", "in", ["preparing", "ready", "failed"])
      .where("fixture_id", "is not", null).returningAll().executeTakeFirst();
    if (!row) throw new PreviewPairConflictError();
    await trx.executor.insertInto("preview_pair_generations").values({ pair_id: pairId, generation: generation + 1,
      source_sha: candidate.sourceSha, candidate: JSON.stringify(candidate), created_at: new Date(now).toISOString() })
      .onConflict(oc => oc.columns(["pair_id", "generation"]).doNothing()).execute();
    const saved = await trx.executor.selectFrom("preview_pair_generations").selectAll().where("pair_id", "=", pairId)
      .where("generation", "=", generation + 1).executeTakeFirstOrThrow();
    // Schema parsing restores canonical field order after JSONB storage.
    const stored = PreviewPairCandidateSchema.parse(saved.candidate);
    if (saved.source_sha !== candidate.sourceSha || JSON.stringify(stored) !== JSON.stringify(candidate)) throw new PreviewPairConflictError();
    return row;
  });
}

export async function advancePreviewPairUpdate(db: PlatformDB, claim: PreviewPairClaim, prepare: PreparePairMember, now: number) {
  return db.transaction(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('preview-pair-admission', 0))`.execute(trx.executor);
    return withPreviewPairClaim(trx, claim, now, async current => {
      const pair = await current.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", claim.pairId).executeTakeFirstOrThrow();
      const remaining = await current.executor.selectFrom("preview_pair_members").select("machine_id")
        .where("pair_id", "=", claim.pairId).where("generation", "<=", claim.generation).where("provider_absent_at", "is", null).executeTakeFirst();
      if (pair.state !== "updating" || !pair.requested_source_sha || remaining || Date.parse(pair.expires_at) <= now) throw new PreviewPairConflictError();
      const next = await current.executor.selectFrom("preview_pair_generations").selectAll().where("pair_id", "=", claim.pairId)
        .where("generation", "=", claim.generation + 1).executeTakeFirstOrThrow();
      if (next.source_sha !== pair.requested_source_sha) throw new PreviewPairConflictError();
      const updated = await current.executor.updateTable("preview_pairs").set({ state: "preparing", generation: claim.generation + 1,
        source_sha: next.source_sha, requested_source_sha: null, outdated: pair.outdated, revision: sql`revision + 1`,
        claim_id: null, claim_expires_at: null, failure_code: null, next_attempt_at: null })
        .where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation).where("revision", "=", claim.revision)
        .where("claim_id", "=", claim.claimId).returningAll().executeTakeFirstOrThrow();
      await current.executor.updateTable("preview_pair_generations").set({ retired_at: new Date(now).toISOString() })
        .where("pair_id", "=", claim.pairId).where("generation", "<=", claim.generation).where("retired_at", "is", null).execute();
      await prepareLeasedPairMembers(current, claim.pairId, updated.generation, prepare);
      return updated;
    });
  });
}
