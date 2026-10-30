import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import { z } from "zod/v4";
import { PreviewPairGenerationSchema, PreviewPairIdSchema, PreviewPairShaSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import type { PreviewPairCloudIntentsTable } from "./types.js";
import { PreviewPairConflictError } from "./repository.js";
import { previewPairOperation } from "./operation.js";
import { publicationParentAllows } from "./publication-journal.js";

export interface PreviewPairIntentClaim { pairId: string; generation: number; revision: number; claimId: string }
export type PreviewPairIntentRow = Selectable<PreviewPairCloudIntentsTable>;
export type PreviewPairIntentRetirement = (row: PreviewPairIntentRow, claim: PreviewPairIntentClaim, signal: AbortSignal) => Promise<boolean>;
const Claim = z.strictObject({ pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), claimId: PreviewPairIdSchema });
const Request = z.strictObject({ open: z.boolean(), requested: z.boolean(), sourceSha: PreviewPairShaSchema });
function time(now: number) { if (!Number.isFinite(now)) throw new PreviewPairConflictError(); return new Date(now).toISOString(); }

/** DB-only fence. Every provider mutation calls it again immediately before the
 * effect. No transaction or connection is retained across external calls. */
export async function withPreviewPairIntentClaim<T>(db: PlatformDB, raw: PreviewPairIntentClaim, now: number,
  work: (trx: PlatformDB, row: PreviewPairIntentRow) => Promise<T>): Promise<T> {
  const claim = Claim.parse(raw);
  return db.transaction(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('preview-pair-admission', 0))`.execute(trx.executor);
    const row = await trx.executor.selectFrom("preview_pair_cloud_intents").selectAll().where("pair_id", "=", claim.pairId)
      .where("generation", "=", claim.generation).where("revision", "=", claim.revision).where("claim_id", "=", claim.claimId)
      .where("claim_expires_at", ">", time(now)).where("state", "in", ["prepared", "cleanup_pending"]).forUpdate().executeTakeFirst();
    if (!row) throw new PreviewPairConflictError();
    return work(trx, row);
  });
}

export function createPreviewPairIntentRecovery(options: { db: PlatformDB; admissionEnabled: boolean; profileFingerprint?: string; now: () => number;
  inspectRequest(input: { pairId: string; generation: number; pr: number }, signal: AbortSignal): Promise<unknown>;
  retire?: PreviewPairIntentRetirement }) {
  const { db, now } = options;
  return async (limit: number) => {
    z.number().int().min(1).max(16).parse(limit);
    const started = performance.now(), current = time(now());
    const due = await db.executor.selectFrom("preview_pair_cloud_intents").selectAll()
      .where("state", "in", ["prepared", "cleanup_pending"])
      .where(eb => eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", current),
        eb.and([eb("state", "=", "prepared"), eb("expires_at", "<=", current)])]))
      .where(eb => eb.or([eb("claim_expires_at", "is", null), eb("claim_expires_at", "<=", current)]))
      .orderBy(sql`CASE WHEN state = 'cleanup_pending' OR expires_at <= ${current} THEN 0 ELSE 1 END`)
      .orderBy("next_attempt_at", sql`asc nulls first`).orderBy("created_at").orderBy("pair_id").orderBy("generation").limit(limit).execute();
    let checked = 0, failed = 0;
    for (const old of due) {
      if (checked && performance.now() - started > 5_000) break;
      checked++;
      const claimId = randomUUID();
      const row = await db.executor.updateTable("preview_pair_cloud_intents").set({ claim_id: claimId,
        claim_expires_at: time(now() + 120_000), revision: sql`revision + 1`, attempt: sql`attempt + 1` })
        .where("pair_id", "=", old.pair_id).where("generation", "=", old.generation).where("revision", "=", old.revision)
        .where("state", "in", ["prepared", "cleanup_pending"])
        .where(eb => eb.or([eb("claim_expires_at", "is", null), eb("claim_expires_at", "<=", time(now()))]))
        .returningAll().executeTakeFirst();
      if (!row) continue;
      const claim = { pairId: row.pair_id, generation: row.generation, revision: row.revision, claimId };
      let failure: string | null = null, stage = "authority";
      try {
        if (!options.profileFingerprint || row.profile_fingerprint !== options.profileFingerprint) throw new PreviewPairConflictError();
        stage = "controller_unavailable";
        let pending = !options.admissionEnabled || row.state === "cleanup_pending" || Date.parse(row.expires_at) <= now()
          || !await publicationParentAllows(db, { pairId: row.pair_id, generation: row.generation, pr: row.pr }, now());
        if (!pending) {
          const request = Request.parse(await previewPairOperation(signal => options.inspectRequest({ pairId: row.pair_id,
            generation: row.generation, pr: row.pr }, signal)));
          pending = !request.open || !request.requested || request.sourceSha !== row.source_sha;
        }
        if (pending) {
          stage = "cleanup_unconfirmed";
          await withPreviewPairIntentClaim(db, claim, now(), async (trx, saved) => {
            if (saved.state === "cleanup_pending") return;
            const changed = await trx.executor.updateTable("preview_pair_cloud_intents").set({ state: "cleanup_pending", revision: sql`revision + 1` })
              .where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation).where("revision", "=", claim.revision)
              .where("claim_id", "=", claim.claimId).where("state", "=", "prepared").returning("revision").executeTakeFirstOrThrow();
            claim.revision = changed.revision;
          });
          const saved = await withPreviewPairIntentClaim(db, claim, now(), async (_trx, fresh) => fresh);
          const absent = z.boolean().parse(await previewPairOperation(signal => options.retire ? options.retire(saved, claim, signal)
            : Promise.resolve(saved.publication_state === "unissued")));
          if (absent) {
            await withPreviewPairIntentClaim(db, claim, now(), async (trx, saved) => {
              if (saved.state !== "cleanup_pending") throw new PreviewPairConflictError();
              await trx.executor.updateTable("preview_pair_cloud_intents").set({ state: "stopped", stopped_at: time(now()),
                revision: sql`revision + 1`, claim_id: null, claim_expires_at: null, next_attempt_at: null, failure_code: null })
                .where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation).where("revision", "=", claim.revision)
                .where("claim_id", "=", claim.claimId).where("state", "=", "cleanup_pending").returning("pair_id").executeTakeFirstOrThrow();
            });
            continue;
          }
          failure = "cleanup_unconfirmed";
        }
      } catch (error: unknown) {
        failed++; failure = stage;
        console.warn("[preview-pair] request recovery deferred", error instanceof Error ? error.name : "UnknownError");
      }
      await db.executor.updateTable("preview_pair_cloud_intents").set({ revision: sql`revision + 1`, claim_id: null,
        claim_expires_at: null, failure_code: failure,
        next_attempt_at: time(now() + Math.min(300_000, 15_000 * 2 ** Math.min(row.attempt - 1, 5))) })
        .where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation).where("revision", "=", claim.revision)
        .where("claim_id", "=", claim.claimId).where("claim_expires_at", ">", time(now()))
        .where("state", "in", ["prepared", "cleanup_pending"]).execute();
    }
    return { checked, failed };
  };
}
