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

async function labelDisagreements(db: Kysely<BrainDatabase>, scope: BrainScopeKey, before: Before): Promise<Found[]> {
  const rows = (await claimRows(db, scope, ["decision", "invariant"], before)).filter((row) => row.label !== null);
  const shaped = rows.map((row) => ({
    row, label: row.label!, shape: statementClauses(row.statement), text: normalizeBrainClaimText(row.statement),
  }));
  const groups = groupBy(shaped, ({ label }) => {
    const key = normalizeBrainClaimText(label);
    return key === DEFERRED_LABEL ? null : key;
  });
  return pickPairs(groups, (x, y) => (x.text === y.text || contradiction(x.shape, y.shape) === null ? null : {
    rule: "label_disagreement",
    summary: (newer, older) => `${newer.label} and ${older.label} disagree on "${x.label}"`,
  }));
}

interface SpecRow {
  readonly document_id: string; readonly title: string; readonly head: string;
  readonly source_updated_at: Date | string; readonly spec: string | null;
}
interface ShippedRow {
  readonly spec: string; readonly document_id: string; readonly title: string; readonly at: Date | string;
}

async function draftSpecsShipped(db: Kysely<BrainDatabase>, scope: BrainScopeKey, before: Before): Promise<Found[]> {
  const { rows: specs } = await sql<SpecRow>`
    SELECT d.document_id, d.title, left(d.body, 4096) AS head, d.source_updated_at,
      (SELECT min(r.value) FROM brain_document_refs r WHERE r.owner_id = d.owner_id AND r.scope_id = d.scope_id
        AND r.document_id = d.document_id AND r.kind = 'spec') AS spec
    FROM brain_documents d
    WHERE d.owner_id = ${scope.ownerId} AND d.scope_id = ${scope.scopeId} AND d.deleted_at IS NULL
      AND d.provenance = 'git_spec' ${beforeSql(before)}
    ORDER BY d.source_updated_at DESC, d.document_id DESC LIMIT ${BRIEF_SCANS.specDocuments}`.execute(db);
  const drafts = specs.flatMap((spec) => {
    const line = spec.spec === null || PART_TWO_OR_LATER.test(spec.title) ? null
      : draftStatusLine(spec.head, BRIEF_QUOTE_MAX_CHARS);
    return line === null ? [] : [{ spec, dir: spec.spec!, line, at: new Date(spec.source_updated_at).getTime() }];
  });
  if (drafts.length === 0) return [];
  // Only pull requests dated after a Draft spec of their dir fill the scan; drafts run newest first, so the map keeps
  // each dir's oldest Draft date.
  const dirs = [...new Map(drafts.map((draft) => [draft.dir, draft.at]))];
  const { rows: shipped } = await sql<ShippedRow>`
    SELECT r.value AS spec, d.document_id, d.title, d.source_updated_at AS at
    FROM (VALUES ${sql.join(dirs.map(([dir, at]) => sql`(${dir}, ${new Date(at)}::timestamptz)`))}) v (spec, draft_at)
    JOIN brain_document_refs r ON r.value = v.spec JOIN brain_documents d ON d.owner_id = r.owner_id
      AND d.scope_id = r.scope_id AND d.document_id = r.document_id AND d.source_updated_at > v.draft_at
    WHERE r.owner_id = ${scope.ownerId} AND r.scope_id = ${scope.scopeId} AND r.kind = 'spec' AND d.deleted_at IS NULL
      AND (d.provenance = 'git_pr' OR (d.provenance = 'github_pr' AND EXISTS (SELECT 1 FROM brain_document_refs s
        WHERE s.owner_id = d.owner_id AND s.scope_id = d.scope_id AND s.document_id = d.document_id
          AND s.kind = 'status' AND s.value = 'merged')))
      AND EXISTS (SELECT 1 FROM brain_document_refs p WHERE p.owner_id = d.owner_id AND p.scope_id = d.scope_id
        AND p.document_id = d.document_id AND p.kind = 'path' AND left(p.value, 6) <> 'specs/') ${beforeSql(before)}
    ORDER BY d.source_updated_at ASC, d.document_id ASC LIMIT ${BRIEF_SCANS.shippedPullRequests}`.execute(db);
  return drafts.flatMap((draft) => {
    const later = shipped.filter((row) => row.spec === draft.dir && new Date(row.at).getTime() > draft.at);
    if (later.length === 0) return [];
    const first = later[0]!;
    const pr: Side = {
      documentId: first.document_id, claimId: null, statement: null,
      quote: cutUnits(first.title, BRIEF_QUOTE_MAX_CHARS), at: new Date(first.at).getTime(),
    };
    const spec: Side = {
      documentId: draft.spec.document_id, claimId: null, statement: null, quote: draft.line, at: draft.at,
    };
    const more = later.length > 1 ? ` and ${later.length - 1} later pull requests` : "";
    return [{
      rule: "draft_spec_shipped" as const, sides: [pr, spec] as const,
      summary: (newer: BrainCiteView) =>
        `${draft.dir} still reads Draft, but ${newer.label}${more} shipped work for it`,
    }];
  });
}

async function commitmentsReversed(db: Kysely<BrainDatabase>, scope: BrainScopeKey, before: Before): Promise<Found[]> {
  const items = (await claimRows(db, scope, ["commitment"], before)).flatMap((row) => {
    const state = commitmentState(row.statement, row.status);
    const words = commitmentWords(row.statement);
    return state === null || words.length < 2 ? [] : [{ row, state, words }];
  });
  const groups = groupBy(items, ({ row }) => normalizeBrainClaimText(row.label ?? ""));
  return pickPairs(groups, (x, y) => (x.state === y.state || overlap(x.words, y.words) < 0.5 ? null : {
    rule: "commitment_reversed",
    summary: (newer, older) => (x.state === "done"
      ? `${newer.label} marks done what ${older.label} deferred`
      : `${newer.label} defers what ${older.label} marked done`),
  }));
}

export function conflictId(rule: BrainConflictRule, sides: readonly [Side, Side]): string {
  const keys = sides.map(sideKey).sort();
  return `cfl_${createHash("sha256").update(JSON.stringify([rule, keys])).digest("hex").slice(0, 32)}`;
}

type Rule = (db: Kysely<BrainDatabase>, scope: BrainScopeKey, before: Before) => Promise<Found[]>;
const RULES: Readonly<Record<BrainConflictRule, Rule>> = {
  label_disagreement: labelDisagreements, draft_spec_shipped: draftSpecsShipped,
  commitment_reversed: commitmentsReversed,
};

/**
 * Every conflict of the given rules, newest side first, then by id. A side whose document went away drops it.
 * `before`: only documents dated before it count (a brief of a past day sees the brain as it was then).
 */
export async function computeConflicts(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, rules: readonly BrainConflictRule[], before: Before = null,
): Promise<BrainConflictView[]> {
  const found: Found[] = [];
  for (const rule of rules) found.push(...await RULES[rule](db, scope, before));
  const cites = await loadCites(db, scope, found.flatMap(({ sides }) => sides.map((side) => side.documentId)));
  const views = found.flatMap(({ rule, sides, summary }) => {
    const [newer, older] = [cites.get(sides[0].documentId), cites.get(sides[1].documentId)];
    if (newer === undefined || older === undefined) return [];
    const side = (view: Side, cite: BrainCiteView): BrainConflictSideView =>
      ({ cite, claimId: view.claimId, statement: view.statement, quote: view.quote });
    return [{
      conflictId: conflictId(rule, sides), rule, summary: lineText(summary(newer, older)),
      sides: [side(sides[0], newer), side(sides[1], older)] as const, detectedAt: iso(new Date(sides[0].at)),
    }];
  });
  return views.sort((x, y) => y.detectedAt.localeCompare(x.detectedAt) || x.conflictId.localeCompare(y.conflictId));
}
