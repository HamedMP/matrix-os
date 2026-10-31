import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod/v4";
import { PreviewPairDigestSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import { PreviewPairCloudIntentSchema } from "./cloud-intents.js";
import { PreviewPairConflictError } from "./repository.js";
import type { PreviewPairPublicationIdentity, PreviewPairPublicationInput } from "./publication-contract.js";

export async function publicationParentAllows(db: PlatformDB, input: Pick<PreviewPairPublicationIdentity, "pairId" | "generation" | "pr">, now: number) {
  const pair = await db.executor.selectFrom("preview_pairs").selectAll().where("pr", "=", input.pr)
    .where("state", "!=", "stopped").executeTakeFirst();
  return input.generation === 1 ? !pair : Boolean(pair && pair.pair_id === input.pairId && pair.generation === input.generation - 1
    && ["preparing", "ready", "failed"].includes(pair.state) && Date.parse(pair.expires_at) > now);
}

export async function readOwnedPublication(db: PlatformDB, config: EnabledPreviewPairConfig,
  raw: PreviewPairPublicationIdentity, now: number) {
  // Internal callers may also carry the separately validated image digest.
  const input = PreviewPairCloudIntentSchema.strip().parse(raw);
  if (!Number.isFinite(now) || !config.admissionEnabled || !config.sourceProfileFingerprint
    || config.sourceProfileFingerprint !== input.profileFingerprint) throw new PreviewPairConflictError();
  await db.ready;
  const row = await db.executor.selectFrom("preview_pair_cloud_intents").selectAll().where("pair_id", "=", input.pairId)
    .where("generation", "=", input.generation).where("pr", "=", input.pr).where("requester_id", "=", input.requesterId)
    .where("source_sha", "=", input.sourceSha).where("controller_run_id", "=", String(input.controllerRunId))
    .where("profile_fingerprint", "=", input.profileFingerprint).where("state", "in", ["prepared", "adopted"]).executeTakeFirst();
  if (!row || row.state === "prepared" && Date.parse(row.expires_at) <= now) throw new PreviewPairConflictError();
  return row;
}

/** The only transition that authorizes a create effect. No network under lock;
 * one winner stores the immutable digest and nonce before making that effect. */
export async function beginPreviewPairPublication(db: PlatformDB, config: EnabledPreviewPairConfig,
  raw: PreviewPairPublicationInput, now: number, proposedId = randomUUID()) {
  PreviewPairDigestSchema.parse(raw.imageSha256);
  z.uuid().parse(proposedId);
  return db.transaction(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('preview-pair-admission', 0))`.execute(trx.executor);
    const row = await readOwnedPublication(trx, config, raw, now);
    if (row.state !== "prepared" || row.image_sha256 !== null && row.image_sha256 !== raw.imageSha256) throw new PreviewPairConflictError();
    if (row.publication_state !== "unissued") return { issue: false, row };
    if (!await publicationParentAllows(trx, raw, now)) throw new PreviewPairConflictError();
    const saved = await trx.executor.updateTable("preview_pair_cloud_intents").set({ publication_id: proposedId,
      publication_state: "issuing", image_sha256: raw.imageSha256, revision: sql`revision + 1`,
      claim_id: null, claim_expires_at: null, next_attempt_at: new Date(now).toISOString(), failure_code: null })
      .where("pair_id", "=", raw.pairId).where("generation", "=", raw.generation).where("revision", "=", row.revision)
      .where("state", "=", "prepared").where("publication_state", "=", "unissued")
      .where("expires_at", ">", new Date(now).toISOString()).returningAll().executeTakeFirstOrThrow();
    return { issue: true, row: saved };
  });
}

/** A late response after cancellation still belongs in its original journal.
 * Recording it invalidates old cleanup claims; it never reopens the request. */
export async function recordPreviewPairPublication(db: PlatformDB, raw: PreviewPairPublicationIdentity,
  publicationId: string, result: { operationName: string } | { rejected: true }, now: number) {
  const input = PreviewPairCloudIntentSchema.strip().parse(raw); z.uuid().parse(publicationId);
  const operationName = "operationName" in result ? z.string().min(1).max(256).parse(result.operationName) : null;
  if (!Number.isFinite(now)) throw new PreviewPairConflictError();
  return db.transaction(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('preview-pair-admission', 0))`.execute(trx.executor);
    const row = await trx.executor.selectFrom("preview_pair_cloud_intents").selectAll().where("pair_id", "=", input.pairId)
      .where("generation", "=", input.generation).where("pr", "=", input.pr).where("requester_id", "=", input.requesterId)
      .where("source_sha", "=", input.sourceSha).where("controller_run_id", "=", String(input.controllerRunId))
      .where("profile_fingerprint", "=", input.profileFingerprint).where("publication_id", "=", publicationId).forUpdate().executeTakeFirst();
    if (!row) throw new PreviewPairConflictError();
    if (row.publication_state === "accepted" && row.operation_name === operationName) return row;
    if (row.publication_state === "rejected" && operationName === null) return row;
    if (row.publication_state !== "issuing" || !["prepared", "cleanup_pending"].includes(row.state)) throw new PreviewPairConflictError();
    return trx.executor.updateTable("preview_pair_cloud_intents").set({ publication_state: operationName ? "accepted" : "rejected",
      operation_name: operationName, revision: sql`revision + 1`, claim_id: null, claim_expires_at: null,
      next_attempt_at: new Date(now).toISOString(), failure_code: operationName ? null : "publication_unavailable" })
      .where("pair_id", "=", input.pairId).where("generation", "=", input.generation).where("revision", "=", row.revision)
      .where("publication_id", "=", publicationId).where("publication_state", "=", "issuing").returningAll().executeTakeFirstOrThrow();
  });
}
