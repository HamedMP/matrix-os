/**
 * Claim write primitives, run inside BrainRepository.withScopeWrite (per-scope advisory lock). A document's claims for
 * one extractor and its extraction state change together, and only while the named run is the scope's running run. A
 * rules write also removes the document's claims and state of every other rules version, so a document holds at most
 * one rules generation; model rows are never touched by it.
 */
import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import type { BrainExecutor } from "../documents.js";
import { asIso, asNullableIso } from "../mappers.js";
import { BrainStoreError, type BrainScopeKey } from "../types.js";
import type { BrainParsedApplyDocumentExtraction, BrainParsedCloseExtractionRun } from "./schemas.js";
import {
  BRAIN_CLAIMS_PER_DOCUMENT_MAX, BRAIN_EXTRACTION_RUN_LEASE_MS, BRAIN_EXTRACTION_RUNS_PER_SCOPE,
  BRAIN_MODEL_SPEND_WINDOW_MS, BRAIN_RETIRED_RUNS_SCOPE_ID, BRAIN_RULES_EXTRACTOR_PREFIX, isBrainRulesExtractorId,
  type BrainApplyDocumentExtractionResult, type BrainClaimInput, type BrainExtractionRun, type BrainExtractionRunsTable,
  type BrainPendingExtractionPage, type BrainPendingExtractionQuery,
} from "./types.js";

/** Mirrors the attempts CHECK in claims/database.ts. */
const ATTEMPTS_MAX = 1_000;
const CLAIM_DATA_TABLES = ["brain_claims", "brain_extraction_state"] as const;
/** LIKE pattern of every rules extractor id; the prefix holds no wildcard. */
export const BRAIN_RULES_EXTRACTOR_LIKE = `${BRAIN_RULES_EXTRACTOR_PREFIX}%`;

const conflict = (): BrainStoreError => new BrainStoreError("conflict");

export function toBrainExtractionRun(row: Selectable<BrainExtractionRunsTable>): BrainExtractionRun {
  return {
    scopeId: row.scope_id, runId: row.run_id, extractor: row.extractor, status: row.status,
    counts: { documentsProcessed: row.documents_processed, documentsFailed: row.documents_failed,
      claimsWritten: row.claims_written, claimsRemoved: row.claims_removed, claimsRejected: row.claims_rejected,
      quotesRejected: row.quotes_rejected },
    usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens, costMicroUsd: row.cost_microusd,
      cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens },
    nextAction: row.next_action, errorCode: row.error_code,
    startedAt: asIso(row.started_at), finishedAt: asNullableIso(row.finished_at),
  };
}

/**
 * Live documents with no state row for the extractor, a row for another (incarnation, revision), a pending row, or a
 * failed row below maxAttempts, of the given provenances only when named. State of another rules version never makes
 * a document done for this one; for a rules extractor, a document that still has such a row is pending too, so a late
 * write by an older gateway is cleared by the next run. Oldest source_updated_at first, or newest first for order
 * "newest" (the brain_documents_recent index fits both); metadata only, never bodies.
 */
export async function selectPendingExtractions(
  db: BrainExecutor, scope: BrainScopeKey, query: BrainPendingExtractionQuery,
): Promise<BrainPendingExtractionPage> {
  const direction = query.order === "newest" ? "desc" : "asc";
  const rows = await db.selectFrom("brain_documents as d")
    .leftJoin("brain_extraction_state as s", (join) => join
      .onRef("s.owner_id", "=", "d.owner_id").onRef("s.scope_id", "=", "d.scope_id")
      .onRef("s.document_id", "=", "d.document_id").on("s.extractor", "=", query.extractor))
    .select(["d.document_id", "d.incarnation", "d.revision", "d.provenance", "d.byte_count", "d.source_updated_at"])
    .where("d.owner_id", "=", scope.ownerId).where("d.scope_id", "=", scope.scopeId).where("d.deleted_at", "is", null)
    .$if(query.provenances !== undefined, (qb) => qb.where("d.provenance", "in", query.provenances!))
    .where((eb) => eb.or([
      eb("s.document_id", "is", null),
      eb("s.incarnation", "<>", eb.ref("d.incarnation")),
      eb("s.revision", "<>", eb.ref("d.revision")),
      eb("s.status", "=", "pending"),
      eb.and([eb("s.status", "=", "failed"), eb("s.attempts", "<", query.maxAttempts)]),
      ...(isBrainRulesExtractorId(query.extractor) ? [eb.exists(eb.selectFrom("brain_extraction_state as o")
        .select("o.document_id").whereRef("o.owner_id", "=", "d.owner_id").whereRef("o.scope_id", "=", "d.scope_id")
        .whereRef("o.document_id", "=", "d.document_id").where("o.extractor", "like", BRAIN_RULES_EXTRACTOR_LIKE)
        .where("o.extractor", "<>", query.extractor))] : []),
    ]))
    .orderBy("d.source_updated_at", direction).orderBy("d.document_id", direction).limit(query.limit + 1).execute();
  return {
    items: rows.slice(0, query.limit).map((row) => ({
      documentId: row.document_id, incarnation: row.incarnation, revision: row.revision, provenance: row.provenance,
      byteCount: row.byte_count, sourceUpdatedAt: asIso(row.source_updated_at),
    })),
    hasMore: rows.length > query.limit,
  };
}

/**
 * Closes a running run older than the lease as interrupted; any other running run is a conflict. The prune keeps the
 * newest finished runs, and every run that cost anything inside the spend window, which spend.ts sums; it also drops
 * the owner's retired runs (retireBilledRuns) once they leave that window.
 */
export async function openRun(
  db: BrainExecutor, scope: BrainScopeKey, extractor: string, now: Date,
): Promise<BrainExtractionRun> {
  await db.updateTable("brain_extraction_runs").set({ status: "interrupted", finished_at: now })
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("status", "=", "running")
    .where("started_at", "<=", new Date(now.getTime() - BRAIN_EXTRACTION_RUN_LEASE_MS)).execute();
  const running = await db.selectFrom("brain_extraction_runs").select("run_id")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("status", "=", "running")
    .executeTakeFirst();
  if (running) throw conflict();
  const opened = await db.insertInto("brain_extraction_runs").values({
    owner_id: scope.ownerId, scope_id: scope.scopeId, run_id: `xrn_${randomUUID().replaceAll("-", "")}`, extractor,
    status: "running", error_code: null, started_at: now, finished_at: null,
  }).returningAll().executeTakeFirstOrThrow();
  await sql`
    DELETE FROM brain_extraction_runs WHERE ctid IN (
      SELECT ctid FROM brain_extraction_runs
      WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} AND status <> 'running'
        AND NOT (cost_microusd > 0 AND started_at > ${new Date(now.getTime() - BRAIN_MODEL_SPEND_WINDOW_MS)})
      ORDER BY started_at DESC, run_id DESC
      OFFSET ${BRAIN_EXTRACTION_RUNS_PER_SCOPE - 1}
    )
  `.execute(db);
  await db.deleteFrom("brain_extraction_runs").where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", BRAIN_RETIRED_RUNS_SCOPE_ID)
    .where("started_at", "<=", new Date(now.getTime() - BRAIN_MODEL_SPEND_WINDOW_MS)).execute();
  return toBrainExtractionRun(opened);
}

/**
 * Part of a scope erase (under its lock): the scope's billed runs inside the spend window move to
 * BRAIN_RETIRED_RUNS_SCOPE_ID (a running one closed as interrupted) instead of being deleted, so the owner's 30-day
 * model spend survives a project erase. Run rows hold counts, usage and codes only, never document text.
 */
export async function retireBilledRuns(db: BrainExecutor, scope: BrainScopeKey, now: Date): Promise<void> {
  await db.updateTable("brain_extraction_runs").set({
    scope_id: BRAIN_RETIRED_RUNS_SCOPE_ID,
    status: sql`CASE WHEN status = 'running' THEN 'interrupted' ELSE status END`,
    finished_at: sql`COALESCE(finished_at, ${now}::timestamptz)`,
  }).where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("cost_microusd", ">", 0)
    .where("started_at", ">", new Date(now.getTime() - BRAIN_MODEL_SPEND_WINDOW_MS)).execute();
}

/** Claims in the scope, counted up to cap + 1. */
async function countScopeClaims(db: BrainExecutor, scope: BrainScopeKey, cap: number): Promise<number> {
  const bounded = db.selectFrom("brain_claims").select("claim_id")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).limit(cap + 1).as("c");
  return Number((await db.selectFrom(bounded).select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);
}

/** Replaces the document's claims for the extractor; returns new ids written and old ids removed. */
async function replaceClaims(
  db: BrainExecutor, scope: BrainScopeKey, input: BrainParsedApplyDocumentExtraction,
  claims: readonly BrainClaimInput[], body: string, now: Date, maxClaimsPerScope: number,
): Promise<{ written: number; removed: number }> {
  // The write-time form of the verbatim-quote rule: every span indexes the stored body.
  const verbatim = (claim: BrainClaimInput) => body.slice(claim.spanStart, claim.spanEnd) === claim.quote;
  if (!claims.every((claim) => claim.spanEnd <= body.length && verbatim(claim))) throw new BrainStoreError("invalid");
  const ids = claims.map((claim) => claim.claimId);
  const deleteClaims = () => db.deleteFrom("brain_claims")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", input.documentId).where("extractor", "=", input.extractor);
  const existing = (await db.selectFrom("brain_claims").select("claim_id")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", input.documentId).where("extractor", "=", input.extractor)
    .limit(BRAIN_CLAIMS_PER_DOCUMENT_MAX).execute()).map((row) => row.claim_id);
  const written = ids.filter((id) => !existing.includes(id)).length;
  if (written > 0
    && await countScopeClaims(db, scope, maxClaimsPerScope) - existing.length + ids.length > maxClaimsPerScope) {
    throw new BrainStoreError("capacity");
  }
  const dropped = ids.length > 0 ? deleteClaims().where("claim_id", "not in", ids) : deleteClaims();
  const removed = (await dropped.returning("claim_id").execute()).length;
  if (claims.length === 0) return { written, removed };
  await db.insertInto("brain_claims").values(claims.map((claim) => ({
    owner_id: scope.ownerId, scope_id: scope.scopeId, claim_id: claim.claimId, extractor: input.extractor,
    document_id: input.documentId, incarnation: input.incarnation, revision: input.revision, kind: claim.kind,
    label: claim.label, statement: claim.statement, quote: claim.quote, span_start: claim.spanStart,
    span_end: claim.spanEnd, fields: sql`${JSON.stringify(claim.fields)}::jsonb`, confidence: claim.confidence,
    created_at: now,
  }))).onConflict((oc) => oc.columns(["owner_id", "scope_id", "claim_id", "extractor"]).doUpdateSet((eb) => ({
    document_id: eb.ref("excluded.document_id"), incarnation: eb.ref("excluded.incarnation"),
    revision: eb.ref("excluded.revision"), kind: eb.ref("excluded.kind"), label: eb.ref("excluded.label"),
    statement: eb.ref("excluded.statement"), quote: eb.ref("excluded.quote"),
    span_start: eb.ref("excluded.span_start"), span_end: eb.ref("excluded.span_end"),
    fields: eb.ref("excluded.fields"), confidence: eb.ref("excluded.confidence"),
  }))).execute();
  return { written, removed };
}

/**
 * The document's claims and state of every rules version but `extractor`, removed in the caller's transaction; returns
 * the number of claims removed.
 */
async function deleteOtherRulesVersions(
  db: BrainExecutor, scope: BrainScopeKey, documentId: string, extractor: string,
): Promise<number> {
  let removed = 0;
  for (const table of CLAIM_DATA_TABLES) {
    const rows = await db.deleteFrom(table).where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
      .where("document_id", "=", documentId).where("extractor", "like", BRAIN_RULES_EXTRACTOR_LIKE)
      .where("extractor", "<>", extractor).returning("document_id").execute();
    if (table === "brain_claims") removed = rows.length;
  }
  return removed;
}

/**
 * Applies one document's outcome under the run fence. The run's cost so far is saved first (never lowered), so a run
 * that never closes still counts toward the spend cap. A document that is gone or no longer at the extracted
 * (incarnation, revision) writes nothing else. A rules outcome of any status first removes the document's rows of
 * every other rules version (counted in `removed`), so the scope cap never needs room for two generations. failed and
 * skipped outcomes write only state, so the extractor's own earlier claims stay and read as stale. Attempts count per
 * (incarnation, revision).
 */
export async function applyExtraction(
  db: BrainExecutor, scope: BrainScopeKey, input: BrainParsedApplyDocumentExtraction, now: Date, maxClaims: number,
): Promise<BrainApplyDocumentExtractionResult> {
  const run = await db.selectFrom("brain_extraction_runs").select(["status", "extractor"])
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("run_id", "=", input.runId)
    .executeTakeFirst();
  if (run?.status !== "running" || run.extractor !== input.extractor) throw conflict();
  if (input.runCostMicroUsd > 0) {
    await db.updateTable("brain_extraction_runs")
      .set({ cost_microusd: sql<number>`GREATEST(cost_microusd, ${input.runCostMicroUsd})` })
      .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("run_id", "=", input.runId)
      .where("status", "=", "running").execute();
  }
  const live = await db.selectFrom("brain_documents").select(["incarnation", "revision", "body", "deleted_at"])
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", input.documentId).forShare().executeTakeFirst();
  if (!live || live.deleted_at !== null || live.revision !== input.revision
    || live.incarnation !== input.incarnation.toLowerCase()) {
    return { applied: false, reason: "stale" };
  }
  const { outcome } = input;
  const replaced = isBrainRulesExtractorId(input.extractor)
    ? await deleteOtherRulesVersions(db, scope, input.documentId, input.extractor) : 0;
  const counts = outcome.status === "done"
    ? await replaceClaims(db, scope, input, outcome.claims, live.body, now, maxClaims)
    : { written: 0, removed: 0 };
  await db.insertInto("brain_extraction_state").values({
    owner_id: scope.ownerId, scope_id: scope.scopeId, document_id: input.documentId, extractor: input.extractor,
    incarnation: input.incarnation, revision: input.revision, status: outcome.status, attempts: 1,
    error_code: outcome.status === "done" ? null : outcome.errorCode, updated_at: now,
  }).onConflict((oc) => oc.columns(["owner_id", "scope_id", "document_id", "extractor"]).doUpdateSet((eb) => ({
    incarnation: eb.ref("excluded.incarnation"), revision: eb.ref("excluded.revision"),
    status: eb.ref("excluded.status"), error_code: eb.ref("excluded.error_code"),
    updated_at: eb.ref("excluded.updated_at"),
    attempts: sql<number>`CASE WHEN brain_extraction_state.incarnation = excluded.incarnation
      AND brain_extraction_state.revision = excluded.revision
      THEN LEAST(brain_extraction_state.attempts + 1, ${ATTEMPTS_MAX}) ELSE 1 END`,
  }))).execute();
  return { applied: true, written: counts.written, removed: counts.removed + replaced };
}

/**
 * Like closeReceipt: a missing run is not_found, a run that is no longer running is conflict. The cost is never
 * lowered below what the run's writes saved.
 */
export async function closeRun(
  db: BrainExecutor, scope: BrainScopeKey, close: BrainParsedCloseExtractionRun, now: Date,
): Promise<BrainExtractionRun> {
  const run = await db.selectFrom("brain_extraction_runs").select("status")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("run_id", "=", close.runId)
    .executeTakeFirst();
  if (!run) throw new BrainStoreError("not_found");
  if (run.status !== "running") throw conflict();
  const { counts, usage } = close;
  const closed = await db.updateTable("brain_extraction_runs").set({
    status: close.status, documents_processed: counts.documentsProcessed, documents_failed: counts.documentsFailed,
    claims_written: counts.claimsWritten, claims_removed: counts.claimsRemoved,
    claims_rejected: counts.claimsRejected, quotes_rejected: counts.quotesRejected,
    input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
    cost_microusd: sql<number>`GREATEST(cost_microusd, ${usage.costMicroUsd})`,
    cache_read_tokens: usage.cacheReadTokens, cache_write_tokens: usage.cacheWriteTokens,
    next_action: close.nextAction, error_code: close.errorCode, finished_at: now,
  })
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("run_id", "=", close.runId)
    .where("status", "=", "running").returningAll().executeTakeFirstOrThrow(conflict);
  return toBrainExtractionRun(closed);
}

/**
 * Claims and extraction state, for every extractor, of a tombstoned document (applyDelete) or of every document a
 * deleted source owns, live or tombstoned (deleteSource).
 */
export async function deleteClaimData(
  db: BrainExecutor, scope: BrainScopeKey, target: { readonly documentId: string } | { readonly sourceId: string },
): Promise<void> {
  for (const table of CLAIM_DATA_TABLES) {
    await db.deleteFrom(table).where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
      .where((eb) => "documentId" in target ? eb("document_id", "=", target.documentId)
        : eb("document_id", "in", eb.selectFrom("brain_documents").select("document_id").where("owner_id", "=", scope.ownerId)
          .where("scope_id", "=", scope.scopeId).where("source_id", "=", target.sourceId)))
      .execute();
  }
}
