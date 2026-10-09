/**
 * The brief's sections for one scope and window. The window is on source time (source_updated_at), so a first sync
 * that imports history does not fill today's brief. Every line cites at least one live document.
 */
import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { BrainClaimKind } from "../claims/types.js";
import {
  BRAIN_BRIEF_LIMITS, BRAIN_CONFLICT_RULES, BRAIN_STALE_KINDS, type BrainBriefChangeGroup, type BrainBriefLine,
  type BrainBriefSections, type BrainCiteView,
} from "../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import { loadBrainCites as loadCites } from "../cite.js";
import { computeConflicts } from "./conflicts.js";
import { claimFields, commitmentTerms, currentClaims, documentsAsOf, uniqueClaims } from "./reads.js";
import { computeStale, openCommitments } from "./stale.js";
import { lineText } from "./text.js";
import { DAY_MS, type BriefWindowRange } from "./time.js";
import { BRIEF_SCANS, type BriefClaimRow } from "./types.js";

const LIMITS = BRAIN_BRIEF_LIMITS;
const MANUAL_LABEL = "Published by hand";

type LineExtras = Partial<Pick<BrainBriefLine, "claimId" | "claimKind" | "due" | "assignee" | "severity">>;

export function briefLine(
  section: string, key: string, text: string, cites: readonly BrainCiteView[], extras: LineExtras = {},
): BrainBriefLine {
  const lineId = `bl_${createHash("sha256").update(JSON.stringify([section, key])).digest("hex").slice(0, 24)}`;
  return {
    lineId, text: lineText(text), cites: cites.slice(0, LIMITS.citesPerLine), claimId: extras.claimId ?? null,
    claimKind: extras.claimKind ?? null, due: extras.due ?? null, assignee: extras.assignee ?? null,
    severity: extras.severity ?? null,
  };
}

interface ChangeRow {
  readonly document_id: string; readonly source_id: string | null; readonly created: number; readonly revised: number;
  readonly kind: string | null; readonly label: string | null; readonly title: string;
}

async function changes(db: Kysely<BrainDatabase>, scope: BrainScopeKey, range: BriefWindowRange) {
  // Items name the version read (a past brief: as it was). New: first revision, or first published in the window.
  const firstSeen = sql`(a.revision = 1 OR (d.published_at >= ${range.from} AND d.published_at < ${range.to}))`;
  const { rows } = await sql<ChangeRow>`
    SELECT w.document_id, w.source_id, w.created::int AS created, w.revised::int AS revised, s.kind, s.label, w.title
    FROM (
      SELECT d.document_id, d.source_id, a.title,
        row_number() OVER (PARTITION BY d.source_id ORDER BY a.dated DESC, d.document_id DESC) AS rn,
        count(*) FILTER (WHERE ${firstSeen}) OVER (PARTITION BY d.source_id) AS created,
        count(*) FILTER (WHERE NOT ${firstSeen}) OVER (PARTITION BY d.source_id) AS revised
      FROM ${documentsAsOf(scope, range.to)} JOIN brain_documents d ON d.owner_id = ${scope.ownerId}
        AND d.scope_id = ${scope.scopeId} AND d.document_id = a.document_id
      WHERE a.dated >= ${range.from}
    ) w
    LEFT JOIN brain_sources s ON s.owner_id = ${scope.ownerId} AND s.scope_id = ${scope.scopeId}
      AND s.source_id = w.source_id
    WHERE w.rn <= ${LIMITS.changeItemsPerGroup}
    ORDER BY w.source_id, w.rn`.execute(db);
  const cites = await loadCites(db, scope, rows.map((row) => row.document_id));
  const groups = new Map<string, { group: Omit<BrainBriefChangeGroup, "items">; items: BrainBriefLine[] }>();
  for (const row of rows) {
    const key = row.source_id ?? "";
    const entry = groups.get(key) ?? { group: {
      sourceId: row.source_id, sourceKind: row.kind, label: row.label ?? MANUAL_LABEL, created: row.created,
      revised: row.revised,
    }, items: [] };
    const cite = cites.get(row.document_id);
    if (cite !== undefined) entry.items.push(briefLine("changes", row.document_id, row.title, [cite]));
    groups.set(key, entry);
  }
  const sorted = [...groups.values()].sort((x, y) => (y.group.created + y.group.revised)
    - (x.group.created + x.group.revised) || x.group.label.localeCompare(y.group.label));
  const truncated = sorted.length > LIMITS.changeGroupsMax
    || sorted.some(({ group }) => group.created + group.revised > LIMITS.changeItemsPerGroup);
  const kept = sorted.slice(0, LIMITS.changeGroupsMax).map(({ group, items }) => ({ ...group, items }));
  return { groups: kept, truncated };
}

function claimLine(section: string, row: BriefClaimRow, cite: BrainCiteView): BrainBriefLine {
  const terms = row.kind === "commitment" ? commitmentTerms(row) : {};
  const text = row.label === null ? row.statement : `${row.label}: ${row.statement}`;
  return briefLine(section, row.claim_id, text, [cite], {
    claimId: row.claim_id, claimKind: row.kind, ...terms,
    severity: row.kind === "risk" ? claimFields(row).severity : undefined,
  });
}

async function claimLines(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, section: string, rows: readonly BriefClaimRow[],
) {
  const cites = await loadCites(db, scope, rows.slice(0, LIMITS.linesPerSection).map((row) => row.document_id));
  const lines = rows.slice(0, LIMITS.linesPerSection).flatMap((row) => {
    const cite = cites.get(row.document_id);
    return cite === undefined ? [] : [claimLine(section, row, cite)];
  });
  return { lines, truncated: rows.length > LIMITS.linesPerSection };
}

/** Claims first seen in the window: a revised document only adds claims written after its new revision. Claims keep no
 * history: an `earlier` line whose claim was deleted stays if its document was edited after it, but not by the window
 * end (a re-extraction of the same revision is left to decide). */
async function newClaims(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, range: BriefWindowRange, kind: BrainClaimKind,
  earlier: readonly BrainBriefLine[] = [],
) {
  const rows = await currentClaims(db, scope, range.to).where("c.kind", "=", kind).where("a.dated", ">=", range.from)
    .where((eb) => eb.or([eb("a.revision", "=", 1), eb("c.created_at", ">=", eb.ref("a.written"))]))
    .orderBy("a.dated", "desc").orderBy("d.document_id", "desc")
    .orderBy("c.span_start").orderBy("c.claim_id")
    .limit((LIMITS.linesPerSection + 1) * 2).execute();
  const part = await claimLines(db, scope, kind, uniqueClaims(rows));
  const lost = earlier.filter((line) => line.claimId !== null && part.lines.every((x) => x.claimId !== line.claimId));
  if (lost.length === 0) return part;
  const { rows: gone } = await sql<{ claim_id: string; revision: number }>`SELECT v.claim_id, a.revision
    FROM (VALUES ${sql.join(lost.map((line) => sql`(${line.claimId}, ${line.cites[0]!.documentId})`))}) v (claim_id, id)
    JOIN ${documentsAsOf(scope, range.to)} ON a.document_id = v.id WHERE NOT EXISTS (SELECT 1 FROM brain_claims c
      WHERE c.owner_id = ${scope.ownerId} AND c.scope_id = ${scope.scopeId} AND c.claim_id = v.claim_id)`.execute(db);
  const cites = await loadCites(db, scope, lost.map((line) => line.cites[0]!.documentId));
  const lines = [...part.lines, ...lost.flatMap((line) => {
    const [{ documentId, revision }, end] = [line.cites[0]!, gone.find((row) => row.claim_id === line.claimId)];
    const cite = cites.get(documentId);
    const keep = cite !== undefined && end !== undefined && end.revision <= revision && revision < cite.revision;
    return keep ? [{ ...line, cites: [cite] }] : [];
  })];
  const cap = LIMITS.linesPerSection;
  return { lines: lines.slice(0, cap), truncated: part.truncated || lines.length > cap };
}

/**
 * The conflicts a brief lists: those detected in its window, newest first, then the others in a rotation that moves
 * by one window's worth of slots per day, so every open conflict shows up in some brief.
 */
export function pickAttentionConflicts<T extends { readonly detectedAt: string }>(
  conflicts: readonly T[], range: BriefWindowRange, slots: number,
): T[] {
  const inWindow = (item: T) => item.detectedAt >= range.from.toISOString() && item.detectedAt < range.to.toISOString();
  const rest = conflicts.filter((item) => !inWindow(item));
  const offset = rest.length === 0 ? 0 : (Math.floor(range.to.getTime() / DAY_MS) * slots) % rest.length;
  return [...conflicts.filter(inWindow), ...rest.slice(offset), ...rest.slice(0, offset)].slice(0, slots);
}

/** Open conflicts, overdue commitments, failing or old sources and claims outdated in the window. */
async function attention(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, range: BriefWindowRange, now: Date, before: Date | null,
) {
  const conflicts = await computeConflicts(db, scope, BRAIN_CONFLICT_RULES, before);
  const picked = pickAttentionConflicts(conflicts, range, BRIEF_SCANS.attentionConflicts);
  const lines = picked.map((conflict) => briefLine(
    "attention", conflict.conflictId, conflict.summary, conflict.sides.map((side) => side.cite)));
  const stale = await computeStale(db, scope, {
    kinds: BRAIN_STALE_KINDS, now, overdueBefore: range.date, before, outdatedIn: { from: range.from, to: range.to },
  });
  const anchors = stale.flatMap((item) => (item.sourceId !== null && item.anchor !== null ? [item.anchor] : []));
  const sourceCites = await loadCites(db, scope, anchors);
  const counts = new Map<string, number>();
  let dropped = conflicts.length > BRIEF_SCANS.attentionConflicts;
  for (const item of stale) {
    const cite = item.cite ?? (item.anchor === null ? undefined : sourceCites.get(item.anchor));
    const used = counts.get(item.kind) ?? 0;
    if (cite === undefined) continue;
    if (used >= BRIEF_SCANS.attentionStale || lines.length >= LIMITS.linesPerSection) {
      dropped = true;
      continue;
    }
    counts.set(item.kind, used + 1);
    lines.push(briefLine("attention", `${item.kind}:${item.key}`, item.text, [cite], {
      claimId: item.claimId, claimKind: item.claimKind, due: item.due, assignee: item.assignee,
    }));
  }
  return { lines, truncated: dropped };
}

/** `earlier`: the stored copy this build replaces, if any. */
export async function buildSections(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, range: BriefWindowRange, now: Date,
  earlier: BrainBriefSections | null = null,
): Promise<{ readonly sections: BrainBriefSections; readonly truncated: boolean }> {
  const changed = await changes(db, scope, range);
  const decisions = await newClaims(db, scope, range, "decision", earlier?.decisions);
  const risks = await newClaims(db, scope, range, "risk", earlier?.risks);
  // A past window sees the brain as it was at its end; today's (still open) window sees everything.
  const before = range.to.getTime() <= now.getTime() ? range.to : null;
  const open = await openCommitments(db, scope, { limit: BRIEF_SCANS.commitments, before });
  const commitments = await claimLines(db, scope, "commitment", open);
  const flagged = await attention(db, scope, range, now, before);
  return {
    sections: {
      changes: changed.groups, decisions: decisions.lines, commitments: commitments.lines, risks: risks.lines,
      attention: flagged.lines,
    },
    truncated: [changed, decisions, risks, commitments, flagged].some((part) => part.truncated),
  };
}
