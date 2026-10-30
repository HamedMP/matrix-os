import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod/v4";
import { PreviewPairGenerationSchema, PreviewPairIdSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import { PreviewPairConflictError } from "./repository.js";

const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Identity = z.tuple([PreviewPairIdSchema, PreviewPairGenerationSchema, Revision]);
export interface PreviewPairClaim { pairId: string; generation: number; revision: number; claimId: string }
function time(now: number) { if (!Number.isFinite(now)) throw new PreviewPairConflictError(); return new Date(now).toISOString(); }

export async function claimPreviewPair(db: PlatformDB, pairId: string, generation: number, revision: number, now: number): Promise<PreviewPairClaim> {
  Identity.parse([pairId, generation, revision]);
  const claimId = randomUUID(), current = time(now);
  const claimed = await db.executor.updateTable("preview_pairs").set({ claim_id: claimId,
    claim_expires_at: time(now + 120_000), revision: sql`revision + 1`, attempt: sql`attempt + 1`,
    state: sql`CASE WHEN expires_at <= ${current} THEN 'cleanup_pending' ELSE state END` })
    .where("pair_id", "=", pairId).where("generation", "=", generation).where("revision", "=", revision)
    .where("state", "!=", "stopped").where(eb => eb.or([eb("claim_id", "is", null), eb("claim_expires_at", "<=", current)]))
    .returningAll().executeTakeFirst();
  if (!claimed) throw new PreviewPairConflictError();
  return { pairId, generation, revision: claimed.revision, claimId };
}

/** DB-only callback: external effects belong between short claim checks, not inside this transaction. */
export async function withPreviewPairClaim<T>(db: PlatformDB, claim: PreviewPairClaim, now: number,
  work: (trx: PlatformDB) => Promise<T>): Promise<T> {
  Identity.parse([claim.pairId, claim.generation, claim.revision]); PreviewPairIdSchema.parse(claim.claimId);
  return db.transaction(async trx => {
    const row = await trx.executor.selectFrom("preview_pairs").selectAll()
      .where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation).where("revision", "=", claim.revision)
      .where("claim_id", "=", claim.claimId).where("claim_expires_at", ">", time(now)).where("state", "!=", "stopped")
      .forUpdate().executeTakeFirst();
    if (!row) throw new PreviewPairConflictError();
    return work(trx);
  });
}

export async function requestPreviewPairStop(db: PlatformDB, pairId: string, generation: number, revision: number, now: number) {
  Identity.parse([pairId, generation, revision]); time(now);
  const row = await db.executor.updateTable("preview_pairs").set({ state: "cleanup_pending", revision: sql`revision + 1`,
    claim_id: null, claim_expires_at: null, next_attempt_at: time(now) })
    .where("pair_id", "=", pairId).where("generation", "=", generation).where("revision", "=", revision)
    .where("state", "!=", "stopped").returningAll().executeTakeFirst();
  if (!row) {
    const terminal = await db.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", pairId)
      .where("generation", "=", generation).where("state", "in", ["cleanup_pending", "stopped"]).executeTakeFirst();
    if (terminal && terminal.revision >= revision) return terminal;
    throw new PreviewPairConflictError();
  }
  return row;
}

export async function expirePreviewPairs(db: PlatformDB, now: number, limit: number): Promise<number> {
  z.number().int().min(1).max(16).parse(limit);
  return db.transaction(async trx => {
    const due = await trx.executor.selectFrom("preview_pairs").select(["pair_id", "generation", "revision"])
      .where("expires_at", "<=", time(now)).where("state", "not in", ["cleanup_pending", "stopped"])
      .orderBy("expires_at").limit(limit).forUpdate().skipLocked().execute();
    for (const row of due) await requestPreviewPairStop(trx, row.pair_id, row.generation, row.revision, now);
    return due.length;
  });
}
