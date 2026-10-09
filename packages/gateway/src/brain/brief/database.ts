/**
 * The stored briefs table: one idempotent bootstrap under the brief schema lock, and the reads and writes of stored
 * briefs. Writes take the brief's own per-scope lock (never the core brain:<scopeId> lock) and keep at most
 * BRAIN_BRIEF_LIMITS.storedPerScope rows per scope, newest date first.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod/v4";
import { BRAIN_CLAIM_KINDS } from "../claims/types.js";
import {
  BRAIN_BRIEF_LIMITS, BRAIN_CITE_KINDS, BRAIN_FEATURE_SCHEMA_LOCKS, BRAIN_FEATURE_SCOPE_LOCK_PREFIXES,
  type BrainBriefView, type BrainBriefWindow,
} from "../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import { BRIEF_FINISH_DAYS, type BrainBriefTables } from "./types.js";

type BriefDatabase = BrainDatabase & BrainBriefTables;
export type BrainStoredBrief = Omit<BrainBriefView, "stored">;

const LIMITS = BRAIN_BRIEF_LIMITS;

export async function bootstrapBrainBriefDatabase(db: Kysely<BrainDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${BRAIN_FEATURE_SCHEMA_LOCKS.brief}))`
      .execute(trx);
    // Scope-level rows (no document foreign key): the scope_erased listener deletes them.
    await sql`
      CREATE TABLE IF NOT EXISTS brain_brief_briefs (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        brief_date TEXT NOT NULL CHECK (brief_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
        brief_window TEXT NOT NULL CHECK (brief_window IN ('day', 'week')),
        generated_at TIMESTAMPTZ NOT NULL,
        body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 524288),
        byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 2 AND ${sql.lit(LIMITS.storedMaxBytes)}),
        PRIMARY KEY (owner_id, scope_id, brief_date, brief_window)
      )
    `.execute(trx);
  });
}

const CiteSchema = z.object({
  documentId: z.string(), kind: z.enum(BRAIN_CITE_KINDS), provenance: z.string(), sourceId: z.string().nullable(),
  label: z.string(), title: z.string(), permalink: z.string(), date: z.string(), revision: z.number().int(),
}).strict();
const LineSchema = z.object({
  lineId: z.string(), text: z.string().max(LIMITS.lineTextMaxChars),
  cites: z.array(CiteSchema).min(1).max(LIMITS.citesPerLine), claimId: z.string().nullable(),
  claimKind: z.enum(BRAIN_CLAIM_KINDS).nullable(), due: z.string().nullable(), assignee: z.string().nullable(),
  severity: z.enum(["low", "medium", "high"]).nullable(),
}).strict();
const LinesSchema = z.array(LineSchema).max(LIMITS.linesPerSection);
const StoredBriefSchema = z.object({
  date: z.string(), window: z.enum(["day", "week"]), from: z.string(), to: z.string(), generatedAt: z.string(),
  sections: z.object({
    changes: z.array(z.object({
      sourceId: z.string().nullable(), sourceKind: z.string().nullable(), label: z.string(),
      created: z.number().int().min(0), revised: z.number().int().min(0),
      items: z.array(LineSchema).max(LIMITS.changeItemsPerGroup),
    }).strict()).max(LIMITS.changeGroupsMax),
    decisions: LinesSchema, commitments: LinesSchema, risks: LinesSchema, attention: LinesSchema,
  }).strict(),
  summary: z.object({ text: z.string().max(LIMITS.summaryMaxChars), modelId: z.string(), generatedAt: z.string() })
    .strict().nullable(),
  truncated: z.boolean(),
}).strict();

const briefs = (db: Kysely<BrainDatabase> | Transaction<BrainDatabase>) => db.withTables<BrainBriefTables>();

/** The stored brief, or null when there is none or its body no longer reads as a brief (it is then rebuilt). */
export async function readStoredBrief(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, date: string, window: BrainBriefWindow,
): Promise<BrainStoredBrief | null> {
  const row = await briefs(db).selectFrom("brain_brief_briefs").select("body")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("brief_date", "=", date).where("brief_window", "=", window).executeTakeFirst();
  if (row === undefined) return null;
  const parsed = StoredBriefSchema.safeParse(row.body);
  if (!parsed.success) console.error("[brain-brief] Stored brief unreadable:", parsed.error.name);
  return parsed.success ? parsed.data : null;
}

/** Dates in [since, today) of stored day briefs built before their day ended, newest first. */
export async function unfinishedDays(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, since: string, today: string,
): Promise<string[]> {
  const { rows } = await sql<{ brief_date: string }>`
    SELECT brief_date FROM brain_brief_briefs WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}
      AND brief_window = 'day' AND brief_date >= ${since} AND brief_date < ${today}
      AND generated_at < (body->>'to')::timestamptz ORDER BY brief_date DESC LIMIT ${BRIEF_FINISH_DAYS}`.execute(db);
  return rows.map((row) => row.brief_date);
}

async function withScopeLock<T>(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, work: (trx: Transaction<BriefDatabase>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
    const key = `${BRAIN_FEATURE_SCOPE_LOCK_PREFIXES.brief}${scope.scopeId}`;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${scope.ownerId}), hashtext(${key}))`.execute(trx);
    return work(trx.withTables<BrainBriefTables>());
  });
}

/** Every document a line cites and every source a change group names: at most a few hundred ids. */
function namedIds(brief: BrainStoredBrief): { readonly documents: string[]; readonly sources: string[] } {
  const { changes, decisions, commitments, risks, attention } = brief.sections;
  const lines = [...changes.flatMap((group) => group.items), ...decisions, ...commitments, ...risks, ...attention];
  return {
    documents: [...new Set(lines.flatMap((line) => line.cites.map((cite) => cite.documentId)))],
    sources: [...new Set(changes.flatMap((group) => (group.sourceId === null ? [] : [group.sourceId])))],
  };
}

/** True when a row of `ids` is gone (only eraseScope removes rows; tombstones keep theirs), or with `live` deleted. */
async function anyMissing(
  db: Kysely<BrainDatabase> | Transaction<BriefDatabase>, scope: BrainScopeKey,
  table: "brain_documents" | "brain_sources", ids: readonly string[], live = false,
): Promise<boolean> {
  if (ids.length === 0) return false;
  const column = table === "brain_documents" ? "document_id" : "source_id";
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM ${sql.table(table)}
    WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} AND ${sql.ref(column)} IN (${sql.join(ids)})
      ${live ? sql`AND deleted_at IS NULL` : sql``}`.execute(db);
  return rows[0]!.n < ids.length;
}

/** True when a document the brief cites or a source it names was tombstoned or erased since it was built. */
export async function citesDeleted(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, brief: BrainStoredBrief,
): Promise<boolean> {
  const named = namedIds(brief);
  return await anyMissing(db, scope, "brain_documents", named.documents, true)
    || anyMissing(db, scope, "brain_sources", named.sources, true);
}

/** Rows the prune keeps ahead of (date, window): newer dates, and the day brief of the same date before its week. */
async function storedAhead(trx: Transaction<BriefDatabase>, scope: BrainScopeKey, brief: BrainStoredBrief) {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM brain_brief_briefs
    WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}
      AND (brief_date > ${brief.date} OR (brief_date = ${brief.date} AND brief_window < ${brief.window}))`
    .execute(trx);
  return rows[0]!.n;
}

/**
 * Stores the brief and returns true only when the row now holds it. False when its JSON is over storedMaxBytes, a
 * copy generated later is stored, storedPerScope newer briefs are stored (the prune would drop it), a document it
 * cites was tombstoned while it was built, or a source it names is gone (the scope was erased and the scope_erased
 * listener, under the same lock, already ran). Older dates beyond storedPerScope are pruned in the same transaction.
 */
export async function writeStoredBrief(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, brief: BrainStoredBrief,
): Promise<boolean> {
  const { date, window, from, to, generatedAt, sections, summary, truncated } = brief;
  const json = JSON.stringify({ date, window, from, to, generatedAt, sections, summary, truncated });
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > LIMITS.storedMaxBytes) return false;
  const named = namedIds(brief);
  return withScopeLock(db, scope, async (trx) => {
    if (await anyMissing(trx, scope, "brain_documents", named.documents, true)
      || await anyMissing(trx, scope, "brain_sources", named.sources)) return false;
    if (await storedAhead(trx, scope, brief) >= LIMITS.storedPerScope) return false;
    const written = await trx.insertInto("brain_brief_briefs").values({
      owner_id: scope.ownerId, scope_id: scope.scopeId, brief_date: date, brief_window: window,
      generated_at: generatedAt, body: sql`${json}::jsonb`, byte_count: bytes,
    }).onConflict((oc) => oc.columns(["owner_id", "scope_id", "brief_date", "brief_window"]).doUpdateSet((eb) => ({
      generated_at: eb.ref("excluded.generated_at"), body: eb.ref("excluded.body"),
      byte_count: eb.ref("excluded.byte_count"),
    })).whereRef("brain_brief_briefs.generated_at", "<=", "excluded.generated_at"))
      .returning("brief_date").executeTakeFirst();
    if (written === undefined) return false;
    await sql`
      DELETE FROM brain_brief_briefs b
      WHERE b.owner_id = ${scope.ownerId} AND b.scope_id = ${scope.scopeId}
        AND (b.brief_date, b.brief_window) NOT IN (
          SELECT k.brief_date, k.brief_window FROM brain_brief_briefs k
          WHERE k.owner_id = ${scope.ownerId} AND k.scope_id = ${scope.scopeId}
          ORDER BY k.brief_date DESC, k.brief_window LIMIT ${LIMITS.storedPerScope})`.execute(trx);
    return true;
  });
}

/** Removes every stored brief of the scope, or only `only` while the row still holds that copy (not a newer one). */
export async function deleteStoredBriefs(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, only?: BrainStoredBrief,
): Promise<void> {
  await withScopeLock(db, scope, async (trx) => {
    let query = trx.deleteFrom("brain_brief_briefs").where("owner_id", "=", scope.ownerId)
      .where("scope_id", "=", scope.scopeId);
    if (only !== undefined) query = query.where("brief_date", "=", only.date).where("brief_window", "=", only.window)
      .where("body", "=", sql`${JSON.stringify(only)}::jsonb`);
    await query.execute();
  });
}

/**
 * Deletes every stored brief of the scope that cites a document tombstoned or erased since it was built: a bounded
 * scan of at most storedPerScope rows under the brief scope lock. Returns how many were deleted.
 */
export async function purgeDeletedBriefs(db: Kysely<BrainDatabase>, scope: BrainScopeKey): Promise<number> {
  return withScopeLock(db, scope, async (trx) => {
    const { rows } = await sql<{ brief_date: string }>`
      DELETE FROM brain_brief_briefs b
      WHERE b.owner_id = ${scope.ownerId} AND b.scope_id = ${scope.scopeId} AND EXISTS (
        SELECT 1 FROM jsonb_path_query(b.body, 'lax $.sections.**.cites[*].documentId') AS cited(id)
        LEFT JOIN brain_documents d ON d.owner_id = b.owner_id AND d.scope_id = b.scope_id
          AND d.document_id = cited.id #>> '{}'
        WHERE d.document_id IS NULL OR d.deleted_at IS NOT NULL)
      RETURNING b.brief_date`.execute(trx);
    return rows.length;
  });
}
