/**
 * Conflicts, computed on demand from current claims and documents with bounded scans (BRIEF_SCANS):
 * label_disagreement (same label, statements that contradict by negation or by values), draft_spec_shipped (a Draft
 * spec with later merged work) and commitment_reversed (done versus deferred). Scans run newest first, so in every
 * pair the earlier row is the newer side and comes first.
 */
import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { normalizeBrainClaimText, type BrainClaimKind } from "../claims/types.js";
import type { BrainCiteView, BrainConflictRule, BrainConflictSideView, BrainConflictView } from "../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import { loadBrainCites as loadCites } from "../cite.js";
import { currentClaims, uniqueClaims } from "./reads.js";
import {
  commitmentState, commitmentWords, contradiction, cutUnits, draftStatusLine, overlap, statementClauses,
  lineText,
} from "./text.js";
import { iso } from "./time.js";
import { BRIEF_QUOTE_MAX_CHARS, BRIEF_SCANS, type BriefClaimRow } from "./types.js";

interface Side {
  readonly documentId: string; readonly claimId: string | null; readonly statement: string | null;
  readonly quote: string; readonly at: number;
}
interface Found {
  readonly rule: BrainConflictRule; readonly sides: readonly [Side, Side];
  readonly summary: (newer: BrainCiteView, older: BrainCiteView) => string;
}

const DEFERRED_LABEL = "deferred scope";
const PART_TWO_OR_LATER = / \(part (?:[2-9]|\d{2,}) of \d+\)$/;

function claimSide(row: BriefClaimRow): Side {
  return {
    documentId: row.document_id, claimId: row.claim_id, statement: row.statement,
    quote: cutUnits(row.quote, BRIEF_QUOTE_MAX_CHARS), at: new Date(row.source_updated_at).getTime(),
  };
}

const sideKey = (side: Side): string => side.claimId ?? `doc:${side.documentId}`;

/** Group rows by key (each group capped), keeping scan order. */
function groupBy<T>(items: readonly T[], key: (item: T) => string | null): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    if (name === null) continue;
    const group = groups.get(name) ?? [];
    if (group.length < BRIEF_SCANS.labelGroup) group.push(item);
    groups.set(name, group);
  }
  return [...groups.values()];
}

/**
 * Pairs (earlier row first, other documents) that `match` accepts. At most conflictPairs are compared, row by row
 * across all groups (pairs within each group's first k rows before any with row k + 1), so no group takes the budget.
 * Then cross-source first, newest first, each claim in at most conflictsPerClaim, at most conflictsPerRule in all.
 */
function pickPairs<T extends { readonly row: BriefClaimRow }>(
  groups: readonly (readonly T[])[], match: (x: T, y: T) => Omit<Found, "sides"> | null,
): Found[] {
  const pairs: { readonly found: Found; readonly cross: boolean }[] = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));
  let budget: number = BRIEF_SCANS.conflictPairs;
  for (let j = 1; j < longest && budget > 0; j += 1) {
    for (const group of groups.filter((members) => j < members.length)) {
      for (let i = 0; i < j && budget > 0; i += 1) {
        const [x, y] = [group[i]!, group[j]!];
        if (x.row.document_id === y.row.document_id) continue;
        budget -= 1;
        const found = match(x, y);
        if (found === null) continue;
        const sides = [claimSide(x.row), claimSide(y.row)] as const;
        pairs.push({ found: { ...found, sides }, cross: x.row.source_id !== y.row.source_id });
      }
    }
  }
  pairs.sort((x, y) => Number(y.cross) - Number(x.cross) || y.found.sides[0].at - x.found.sides[0].at);
  const uses = new Map<string, number>();
  const picked: Found[] = [];
  for (const { found } of pairs) {
    if (picked.length >= BRIEF_SCANS.conflictsPerRule) break;
    const keys = found.sides.map(sideKey);
    if (keys.some((key) => (uses.get(key) ?? 0) >= BRIEF_SCANS.conflictsPerClaim)) continue;
    for (const key of keys) uses.set(key, (uses.get(key) ?? 0) + 1);
    picked.push(found);
  }
  return picked;
}

/** Documents dated before this instant only (a past brief); null reads everything. */
type Before = Date | null;
const beforeSql = (before: Before) => (before === null ? sql`` : sql`AND d.source_updated_at < ${before}`);

async function claimRows(db: Kysely<BrainDatabase>, scope: BrainScopeKey, kinds: BrainClaimKind[], before: Before) {
  let query = currentClaims(db, scope).where("c.kind", "in", kinds);
  if (before !== null) query = query.where("d.source_updated_at", "<", before);
  const rows = await query
    .orderBy("d.source_updated_at", "desc").orderBy("d.document_id", "desc").orderBy("c.claim_id")
    .limit(BRIEF_SCANS.conflictClaims).execute();
  return uniqueClaims(rows);
}
