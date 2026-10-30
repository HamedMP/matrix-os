import { sql } from "kysely";
import { z } from "zod/v4";
import { PreviewPairActorSchema, PreviewPairDigestSchema, PreviewPairGenerationSchema,
  PreviewPairIdSchema, PreviewPairPrSchema, PreviewPairShaSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import { PreviewPairConflictError } from "./repository.js";
import { CustomerVpsError } from "../customer-vps-errors.js";

export const PreviewPairCloudIntentSchema = z.strictObject({ pairId: PreviewPairIdSchema,
  generation: PreviewPairGenerationSchema, pr: PreviewPairPrSchema, requesterId: PreviewPairActorSchema,
  sourceSha: PreviewPairShaSchema, controllerRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  profileFingerprint: PreviewPairDigestSchema });
export type PreviewPairCloudIntentInput = z.infer<typeof PreviewPairCloudIntentSchema>;
const PREPARATION_LIFETIME_MS = 2 * 60 * 60 * 1000;

/** Same lock as pair admission and update: cleanup and adoption cannot both win.
 * This is a DB-only operation; controller, issuer and target gates run before it. */
export async function preparePreviewPairCloudIntent(db: PlatformDB, config: EnabledPreviewPairConfig,
  raw: unknown, now: number) {
  const input = PreviewPairCloudIntentSchema.parse(raw);
  if (!Number.isFinite(now) || !config.admissionEnabled
    || input.profileFingerprint !== config.sourceProfileFingerprint) throw new PreviewPairConflictError();
  return db.transaction(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('preview-pair-admission', 0))`.execute(trx.executor);
    const existing = await trx.executor.selectFrom("preview_pair_cloud_intents").selectAll()
      .where("pair_id", "=", input.pairId).where("generation", "=", input.generation).forUpdate().executeTakeFirst();
    if (existing) {
      if (existing.pr !== input.pr || existing.requester_id !== input.requesterId || existing.source_sha !== input.sourceSha
        || existing.controller_run_id !== String(input.controllerRunId) || existing.profile_fingerprint !== input.profileFingerprint
        || !["prepared", "adopted"].includes(existing.state) || Date.parse(existing.expires_at) <= now) throw new PreviewPairConflictError();
      return existing;
    }
    const pair = await trx.executor.selectFrom("preview_pairs").selectAll().where("pr", "=", input.pr)
      .where("state", "!=", "stopped").forUpdate().executeTakeFirst();
    if (pair ? pair.pair_id !== input.pairId || input.generation !== pair.generation + 1
      || !["preparing", "ready", "failed"].includes(pair.state) || Date.parse(pair.expires_at) <= now
      : input.generation !== 1) throw new PreviewPairConflictError();
    const waiting = await trx.executor.selectFrom("preview_pair_cloud_intents").select("pair_id")
      .where("state", "in", ["prepared", "cleanup_pending"]).limit(32).execute();
    if (waiting.length >= 32) throw new CustomerVpsError(429, "quota_exceeded", "Preview pair is unavailable");
    const expires = Math.min(now + PREPARATION_LIFETIME_MS, pair ? Date.parse(pair.expires_at) : Infinity);
    return trx.executor.insertInto("preview_pair_cloud_intents").values({ pair_id: input.pairId, generation: input.generation,
      pr: input.pr, requester_id: input.requesterId, source_sha: input.sourceSha,
      controller_run_id: String(input.controllerRunId), profile_fingerprint: input.profileFingerprint,
      created_at: new Date(now).toISOString(), expires_at: new Date(expires).toISOString() })
      .onConflict(oc => oc.columns(["pair_id", "generation"]).doNothing()).returningAll().executeTakeFirstOrThrow();
  });
}

/** Internal transaction participant. Call only while holding admission's shared
 * lock, in the transaction that inserts/updates the generation and both jobs. */
export async function adoptPreviewPairCloudIntent(trx: PlatformDB, input: PreviewPairCloudIntentInput, now: number) {
  PreviewPairCloudIntentSchema.parse(input);
  const adopted = await trx.executor.updateTable("preview_pair_cloud_intents")
    .set({ state: "adopted", revision: sql`revision + 1` }).where("pair_id", "=", input.pairId)
    .where("generation", "=", input.generation).where("pr", "=", input.pr).where("requester_id", "=", input.requesterId)
    .where("source_sha", "=", input.sourceSha).where("controller_run_id", "=", String(input.controllerRunId))
    .where("profile_fingerprint", "=", input.profileFingerprint).where("state", "=", "prepared")
    .where("expires_at", ">", new Date(now).toISOString()).returning("pair_id").executeTakeFirst();
  if (adopted) return;
  // Idempotent replay is permitted only for the exact generation this intent
  // already adopted. A forged or aborted request cannot consume another lease.
  const existing = await trx.executor.selectFrom("preview_pair_cloud_intents as intent")
    .innerJoin("preview_pair_generations as generation", join => join.onRef("generation.pair_id", "=", "intent.pair_id")
      .onRef("generation.generation", "=", "intent.generation").onRef("generation.source_sha", "=", "intent.source_sha")
      .onRef("generation.controller_run_id", "=", "intent.controller_run_id"))
    .select("intent.pair_id").where("intent.pair_id", "=", input.pairId).where("intent.generation", "=", input.generation)
    .where("intent.pr", "=", input.pr).where("intent.requester_id", "=", input.requesterId)
    .where("intent.source_sha", "=", input.sourceSha).where("intent.controller_run_id", "=", String(input.controllerRunId))
    .where("intent.profile_fingerprint", "=", input.profileFingerprint).where("intent.state", "=", "adopted").executeTakeFirst();
  if (!existing) throw new PreviewPairConflictError();
}

export async function stopPreviewPairCloudIntent(db: PlatformDB, pairId: string, generation: number,
  controllerRunId: number, now: number) {
  PreviewPairIdSchema.parse(pairId); PreviewPairGenerationSchema.parse(generation);
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(controllerRunId);
  if (!Number.isFinite(now)) throw new PreviewPairConflictError();
  return db.transaction(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('preview-pair-admission', 0))`.execute(trx.executor);
    const row = await trx.executor.selectFrom("preview_pair_cloud_intents").selectAll().where("pair_id", "=", pairId)
      .where("generation", "=", generation).where("controller_run_id", "=", String(controllerRunId)).forUpdate().executeTakeFirst();
    if (!row) throw new PreviewPairConflictError();
    if (row.state !== "prepared") return row;
    return trx.executor.updateTable("preview_pair_cloud_intents").set({ state: "cleanup_pending", revision: sql`revision + 1`,
      claim_id: null, claim_expires_at: null, next_attempt_at: new Date(now).toISOString() })
      .where("pair_id", "=", pairId).where("generation", "=", generation).where("revision", "=", row.revision)
      .where("state", "=", "prepared").returningAll().executeTakeFirstOrThrow();
  });
}
