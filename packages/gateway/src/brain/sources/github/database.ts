/**
 * GitHub source tables and their reads and writes. brain_github_sources holds one config row per source;
 * brain_github_conditional holds listing validators (ETag / Last-Modified), each usable only once the cursor that was
 * written with it has committed. Both reference brain_sources ON DELETE CASCADE. Core tables are only read here.
 */
import { sql, type Kysely } from "kysely";
import {
  BRAIN_FEATURE_SCHEMA_LOCKS, BRAIN_FEATURE_SCOPE_LOCK_PREFIXES, BRAIN_PROVENANCES,
  type BrainGithubSourceConfig,
} from "../../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../../index.js";
import { githubRepoOfPermalink, githubRepoOfWebBase, parseBrainGithubConfig } from "./config.js";
import { GITHUB_LIMITS, type BrainGithubTables, type BrainGithubValidators } from "./types.js";

type GithubDb = Kysely<BrainDatabase & BrainGithubTables>;

function githubDb(db: Kysely<BrainDatabase>): GithubDb {
  return db.withTables<BrainGithubTables>();
}

export async function bootstrapBrainGithubDatabase(db: Kysely<BrainDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${BRAIN_FEATURE_SCHEMA_LOCKS.github}))`.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS brain_github_sources (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL CHECK (source_id ~ '^src_[a-f0-9]{32}$'),
        repo TEXT NOT NULL CHECK (char_length(repo) <= 201 AND repo ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
        mode TEXT NOT NULL CHECK (mode IN ('integration', 'token')),
        account_label TEXT CHECK (account_label IS NULL OR (char_length(account_label) BETWEEN 1 AND 100
          AND account_label !~ '[[:cntrl:]]' AND mode = 'integration')),
        include_pull_requests BOOLEAN NOT NULL, include_reviews BOOLEAN NOT NULL, include_issues BOOLEAN NOT NULL,
        since TEXT CHECK (since IS NULL OR since ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'), updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, source_id),
        FOREIGN KEY (owner_id, scope_id, source_id) REFERENCES brain_sources (owner_id, scope_id, source_id) ON DELETE CASCADE,
        CHECK (include_pull_requests OR include_issues), CHECK (include_pull_requests OR NOT include_reviews)
      )
    `.execute(trx);
    // The rest of the config schema's bounds, by name so a table made before them gains them. NOT VALID: such a
    // table's old rows are re-checked by loadGithubConfig instead of blocking startup.
    const strict = await sql<{ present: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'brain_github_sources'::regclass
        AND conname = 'brain_github_sources_values_check') AS present
    `.execute(trx);
    if (strict.rows[0]?.present !== true) {
      await sql`
        ALTER TABLE brain_github_sources ADD CONSTRAINT brain_github_sources_values_check CHECK (
          split_part(repo, '/', 1) NOT IN ('.', '..') AND split_part(repo, '/', 2) NOT IN ('.', '..')
          AND (account_label IS NULL OR account_label ~ '^[^[:space:][:cntrl:]](.*[^[:space:][:cntrl:]])?$')
          AND (since IS NULL OR CASE WHEN since ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            THEN since >= '2008-01-01' AND since::date IS NOT NULL ELSE false END)
        ) NOT VALID
      `.execute(trx);
    }
    await sql`
      CREATE TABLE IF NOT EXISTS brain_github_conditional (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL CHECK (source_id ~ '^src_[a-f0-9]{32}$'),
        request_key TEXT NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
        etag TEXT CHECK (etag IS NULL OR char_length(etag) BETWEEN 3 AND 204),
        last_modified TEXT CHECK (last_modified IS NULL OR char_length(last_modified) = 29),
        pending_cursor TEXT NOT NULL CHECK (pending_cursor ~ '^[a-f0-9]{64}$'),
        confirmed BOOLEAN NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, source_id, request_key),
        FOREIGN KEY (owner_id, scope_id, source_id) REFERENCES brain_sources (owner_id, scope_id, source_id) ON DELETE CASCADE,
        CHECK (etag IS NOT NULL OR last_modified IS NOT NULL)
      )
    `.execute(trx);
  });
}

/**
 * This feature's per-scope lock (never the core brain:<scopeId> lock), in `db` when it is already a transaction (a
 * source update's), else in a transaction of its own.
 */
async function withScopeLock<T>(db: Kysely<BrainDatabase>, scope: BrainScopeKey, work: (trx: GithubDb) => Promise<T>): Promise<T> {
  const locked = async (trx: GithubDb) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
    const lockKey = `${BRAIN_FEATURE_SCOPE_LOCK_PREFIXES.github}${scope.scopeId}`;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${scope.ownerId}), hashtext(${lockKey}))`.execute(trx);
    return work(trx);
  };
  return db.isTransaction ? locked(githubDb(db)) : githubDb(db).transaction().execute(locked);
}

export async function saveGithubConfig(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, sourceId: string, config: BrainGithubSourceConfig, now: Date,
): Promise<void> {
  const row = {
    repo: config.repo, mode: config.mode, account_label: config.accountLabel ?? null,
    include_pull_requests: config.include.pullRequests, include_reviews: config.include.reviews,
    include_issues: config.include.issues, since: config.since ?? null, updated_at: now,
  };
  await withScopeLock(db, scope, (trx) => trx.insertInto("brain_github_sources")
    .values({ owner_id: scope.ownerId, scope_id: scope.scopeId, source_id: sourceId, ...row })
    .onConflict((conflict) => conflict.columns(["owner_id", "scope_id", "source_id"]).doUpdateSet(row)).execute());
}

export async function loadGithubConfig(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, sourceId: string,
): Promise<BrainGithubSourceConfig | null> {
  const row = await githubDb(db).selectFrom("brain_github_sources").selectAll()
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("source_id", "=", sourceId)
    .executeTakeFirst();
  if (row === undefined) return null;
  // Re-checked like client input: a row the CHECKs never saw fails as source_config_invalid, never reaches a URL.
  return parseBrainGithubConfig({
    repo: row.repo, mode: row.mode,
    ...(row.account_label === null ? {} : { accountLabel: row.account_label }),
    include: { pullRequests: row.include_pull_requests, reviews: row.include_reviews, issues: row.include_issues },
    ...(row.since === null ? {} : { since: row.since }),
  });
}

/**
 * "owner/name" of the scope's live git source on github.com, or null when unknown (no git source, another host, or
 * nothing synced yet). A github.com web base names it directly; otherwise (a `project:<id>` ref, whose web base comes
 * from origin on each run) one live git_pr or git_commit permalink of that source does. Plain reads of core tables.
 */
export async function gitSourceRepo(db: Kysely<BrainDatabase>, scope: BrainScopeKey): Promise<string | null> {
  const source = await db.selectFrom("brain_sources").select(["source_id", "external_ref"])
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("kind", "=", "git").where("deleted_at", "is", null).orderBy("created_at").limit(1).executeTakeFirst();
  if (source === undefined) return null;
  const fromRef = githubRepoOfWebBase(source.external_ref);
  if (fromRef !== null) return fromRef;
  const document = await db.selectFrom("brain_documents").select("permalink")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", source.source_id).where("deleted_at", "is", null)
    .where("provenance", "in", [BRAIN_PROVENANCES.gitPr, BRAIN_PROVENANCES.gitCommit])
    .where("permalink", "like", "https://github.com/%").orderBy("document_id").limit(1).executeTakeFirst();
  return document === undefined ? null : githubRepoOfPermalink(document.permalink);
}

/** Live review and review comment documents of this source under one pull request document (deletion sweep). */
export async function listGithubChildren(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, sourceId: string, parentDocumentId: string,
): Promise<string[]> {
  const rows = await db.selectFrom("brain_document_refs as r")
    .innerJoin("brain_documents as d", (join) => join.onRef("d.owner_id", "=", "r.owner_id")
      .onRef("d.scope_id", "=", "r.scope_id").onRef("d.document_id", "=", "r.document_id"))
    .select("d.document_id")
    .where("r.owner_id", "=", scope.ownerId).where("r.scope_id", "=", scope.scopeId)
    .where("r.kind", "=", "parent").where("r.value", "=", parentDocumentId)
    .where("d.source_id", "=", sourceId).where("d.deleted_at", "is", null)
    .where("d.provenance", "in", [BRAIN_PROVENANCES.githubReview, BRAIN_PROVENANCES.githubReviewComment])
    .orderBy("d.document_id").limit(GITHUB_LIMITS.sweepMax).execute();
  return rows.map((row) => row.document_id);
}

export interface GithubConditionalRows {
  /** Marks rows written with this cursor (now committed) usable. */
  confirm(cursorHash: string): Promise<void>;
  lookup(requestKey: string): Promise<BrainGithubValidators | null>;
  /** Stores validators for a page's cursor; confirmed at once when that cursor is already the committed one. */
  persist(
    entries: readonly { key: string; validators: BrainGithubValidators }[], cursorHash: string, confirmed: boolean, now: Date,
  ): Promise<void>;
}

export function githubConditionalRows(db: Kysely<BrainDatabase>, scope: BrainScopeKey, sourceId: string): GithubConditionalRows {
  return {
    async confirm(cursorHash) {
      await withScopeLock(db, scope, (trx) => trx.updateTable("brain_github_conditional").set({ confirmed: true })
        .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("source_id", "=", sourceId)
        .where("pending_cursor", "=", cursorHash).where("confirmed", "=", false).execute());
    },
    async lookup(requestKey) {
      const row = await githubDb(db).selectFrom("brain_github_conditional").select(["etag", "last_modified"])
        .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("source_id", "=", sourceId)
        .where("request_key", "=", requestKey).where("confirmed", "=", true).executeTakeFirst();
      return row === undefined ? null : { etag: row.etag, lastModified: row.last_modified };
    },
    async persist(entries, cursorHash, confirmed, now) {
      if (entries.length === 0) return;
      await withScopeLock(db, scope, async (trx) => {
        for (const entry of entries.slice(0, GITHUB_LIMITS.conditionalRowsPerSource)) {
          const values = {
            etag: entry.validators.etag, last_modified: entry.validators.lastModified,
            pending_cursor: cursorHash, confirmed, updated_at: now,
          };
          await trx.insertInto("brain_github_conditional")
            .values({ owner_id: scope.ownerId, scope_id: scope.scopeId, source_id: sourceId, request_key: entry.key, ...values })
            .onConflict((conflict) => conflict.columns(["owner_id", "scope_id", "source_id", "request_key"]).doUpdateSet(values))
            .execute();
        }
        const keep = trx.selectFrom("brain_github_conditional").select("request_key")
          .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("source_id", "=", sourceId)
          .orderBy("updated_at", "desc").orderBy("request_key").limit(GITHUB_LIMITS.conditionalRowsPerSource);
        await trx.deleteFrom("brain_github_conditional")
          .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("source_id", "=", sourceId)
          .where("request_key", "not in", keep).execute();
      });
    },
  };
}
