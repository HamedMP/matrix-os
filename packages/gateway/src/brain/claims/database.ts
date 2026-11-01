/**
 * Company Brain claim tables, created last in the brain bootstrap transaction. Spans are UTF-16 units; char_length
 * counts code points, so a span is one to two times the quote's char_length.
 */
import { sql, type Transaction } from "kysely";
import type { BrainDatabase } from "../types.js";

/** rules/v<N> or model:<model-id>/<prompt-version>; mirrors BRAIN_EXTRACTOR_ID_PATTERN and its 128-char cap. */
const EXTRACTOR_CHECK = sql.raw(
  "char_length(extractor) <= 128 AND extractor ~ "
  + "'^(rules/v[1-9][0-9]{0,2}|model:[A-Za-z0-9@][A-Za-z0-9@._:/-]{0,94}/[a-z0-9][a-z0-9._-]{0,23})$'",
);

/** Prompt cache token totals, added after the first release of the runs table. */
const CACHE_COUNTERS = ["cache_read_tokens", "cache_write_tokens"] as const;
const counter = (column: string): string => `${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} >= 0)`;

/** Run counters and usage totals: INTEGER, bounded per run by the job's ceilings. */
const COUNTERS = sql.raw(["documents_processed", "documents_failed", "claims_written", "claims_removed",
  "claims_rejected", "quotes_rejected", "input_tokens", "output_tokens", "cost_microusd", ...CACHE_COUNTERS]
  .map(counter).join(",\n"));

export async function createBrainClaimTables(trx: Transaction<BrainDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS brain_claims (
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
      scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
      claim_id TEXT NOT NULL CHECK (claim_id ~ '^[a-f0-9]{64}$'),
      extractor TEXT NOT NULL CHECK (${EXTRACTOR_CHECK}),
      document_id TEXT NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
      incarnation UUID NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      kind TEXT NOT NULL CHECK (kind IN ('invariant', 'decision', 'commitment', 'risk')),
      label TEXT CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 80
        AND strpos(label, chr(10)) = 0 AND strpos(label, chr(13)) = 0)),
      statement TEXT NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 1000),
      quote TEXT NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 2000),
      span_start INTEGER NOT NULL CHECK (span_start >= 0),
      span_end INTEGER NOT NULL CHECK (span_end <= 65536),
      fields JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(fields) = 'object' AND octet_length(fields::text) <= 1024),
      confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, scope_id, claim_id, extractor),
      FOREIGN KEY (owner_id, scope_id, document_id)
        REFERENCES brain_documents (owner_id, scope_id, document_id) ON DELETE CASCADE,
      CHECK (span_end - span_start BETWEEN char_length(quote) AND 2 * char_length(quote))
    )
  `.execute(trx);

  // One row per (document, extractor); a row for an older incarnation or revision reads as pending.
  await sql`
    CREATE TABLE IF NOT EXISTS brain_extraction_state (
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
      scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
      document_id TEXT NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
      extractor TEXT NOT NULL CHECK (${EXTRACTOR_CHECK}),
      incarnation UUID NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
      attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 1000),
      error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, scope_id, document_id, extractor),
      FOREIGN KEY (owner_id, scope_id, document_id)
        REFERENCES brain_documents (owner_id, scope_id, document_id) ON DELETE CASCADE,
      CHECK ((status IN ('failed', 'skipped')) = (error_code IS NOT NULL))
    )
  `.execute(trx);

  // Scope-level history: survives tombstones and source deletes, removed by eraseScope.
  await sql`
    CREATE TABLE IF NOT EXISTS brain_extraction_runs (
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
      scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
      run_id TEXT NOT NULL CHECK (run_id ~ '^xrn_[a-f0-9]{32}$'),
      extractor TEXT NOT NULL CHECK (${EXTRACTOR_CHECK}),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'interrupted')),
      ${COUNTERS},
      next_action TEXT NOT NULL DEFAULT ''
        CHECK (char_length(next_action) <= 500 AND next_action ~ '^([a-z][a-z0-9_]*)?$'),
      error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      PRIMARY KEY (owner_id, scope_id, run_id),
      CHECK ((status = 'running') = (finished_at IS NULL))
    )
  `.execute(trx);
  // A runs table created before the cache counters gets them here; a no-op once they exist.
  for (const column of CACHE_COUNTERS) {
    await sql.raw(`ALTER TABLE brain_extraction_runs ADD COLUMN IF NOT EXISTS ${counter(column)}`).execute(trx);
  }

  // brain_claims_document: replace-delete, existing-id select and the read join per document.
  // brain_extraction_runs_running: the cross-process guard, at most one running run per scope.
  for (const index of [
    "INDEX IF NOT EXISTS brain_claims_document ON brain_claims (owner_id, scope_id, document_id, extractor)",
    "UNIQUE INDEX IF NOT EXISTS brain_extraction_runs_running ON brain_extraction_runs (owner_id, scope_id)"
    + " WHERE status = 'running'",
    "INDEX IF NOT EXISTS brain_extraction_runs_started ON brain_extraction_runs (owner_id, scope_id, started_at DESC)",
    // The owner's 30-day model spend (spend.ts) sums billed runs of every scope.
    "INDEX IF NOT EXISTS brain_extraction_runs_billed ON brain_extraction_runs (owner_id, started_at DESC)"
    + " WHERE cost_microusd > 0",
  ]) await sql.raw(`CREATE ${index}`).execute(trx);
}
