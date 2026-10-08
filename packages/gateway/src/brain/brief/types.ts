/**
 * Company Brief internals: the stored briefs table, scan caps and the row shapes the readers share. The public
 * shapes live in ../contracts/brief.ts.
 */
import type { ColumnType } from "kysely";
import type { BrainClaimKind } from "../claims/types.js";

type Timestamp = ColumnType<Date | string, Date | string, Date | string>;
/** JSONB: written as sql`${JSON.stringify(value)}::jsonb`, read back parsed. */
type JsonValue = ColumnType<unknown, unknown, unknown>;

/** One stored brief per (scope, date, window); body is the BrainBriefView without `stored`. */
export type BrainBriefBriefsTable = {
  owner_id: string; scope_id: string; brief_date: string; brief_window: string; generated_at: Timestamp;
  body: JsonValue; byte_count: number;
};

/** A type alias (not an interface) so Kysely's withTables accepts it. */
export type BrainBriefTables = { brain_brief_briefs: BrainBriefBriefsTable };

/** Rows each reader looks at before it stops; every scan is newest first. */
export const BRIEF_SCANS = {
  conflictClaims: 2_000, labelGroup: 200, conflictPairs: 20_000, conflictsPerClaim: 3, conflictsPerRule: 500,
  specDocuments: 500,
  shippedPullRequests: 5_000, staleItems: 500, commitments: 500, sources: 100, attentionConflicts: 10,
  attentionStale: 20, summaryLines: 200, summaryInputChars: 40_000,
} as const;

/** A stored brief built before its window ended is rebuilt on read once the window ended or it is this old. */
export const BRIEF_REBUILD_AFTER_MS = 3_600_000;
/** One summary call; the request also aborts it. */
export const BRIEF_SUMMARY_TIMEOUT_MS = 60_000;
/** Commitment and conflict quotes are cut to this many UTF-16 units (contract: at most 300). */
export const BRIEF_QUOTE_MAX_CHARS = 300;

/** A current claim of a live document, as the readers select it. */
export interface BriefClaimRow {
  readonly claim_id: string; readonly kind: BrainClaimKind; readonly label: string | null; readonly statement: string;
  readonly quote: string; readonly fields: unknown; readonly document_id: string; readonly source_id: string | null;
  readonly source_updated_at: Date | string; readonly status: string | null;
  /** The document's first due ref that reads YYYY-MM-DD, and its first assignee ref (a person key). */
  readonly due_ref: string | null; readonly assignee_ref: string | null;
}
