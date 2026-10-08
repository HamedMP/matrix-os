/**
 * Stale data, computed on demand with bounded scans: claims read from an older revision, sources with no successful
 * sync for BRAIN_STALE_SOURCE_DAYS, sources whose newest receipt failed, and open commitments past their due date.
 * Also the open-commitments scan the brief's commitments section shares.
 */
import { sql, type Kysely } from "kysely";
import type { BrainClaimKind } from "../claims/types.js";
import {
  BRAIN_STALE_KINDS, BRAIN_STALE_SOURCE_DAYS, type BrainStaleItemView, type BrainStaleKind,
} from "../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import { loadBrainCites as loadCites } from "../cite.js";
import { commitmentDue, commitmentTerms, currentClaims, sourceStates, uniqueClaims } from "./reads.js";
import { closedStatus, commitmentState, lineText } from "./text.js";
import { DAY_MS, iso, parseUtcDate, utcDate } from "./time.js";
import { BRIEF_SCANS, type BriefClaimRow } from "./types.js";

/** An item plus what the brief needs: the document a source line cites, a claim's kind, due and assignee. */
export interface StaleItem extends BrainStaleItemView {
  /** The claim or source id: the tie-break of the order and part of the brief line id. */
  readonly key: string; readonly anchor: string | null; readonly claimKind: BrainClaimKind | null;
  readonly due: string | null; readonly assignee: string | null;
}

/**
 * Open commitments: current, not stated done and not on a done or canceled document; due first, then newest.
 * `before`: only documents dated before it (a past brief).
 */
export async function openCommitments(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey,
  options: { readonly dueBefore?: string; readonly before?: Date | null; readonly limit: number },
): Promise<BriefClaimRow[]> {
  const due = commitmentDue();
  let query = currentClaims(db, scope).where("c.kind", "=", "commitment");
  if (options.dueBefore !== undefined) query = query.where(due, "<", options.dueBefore);
  if (options.before !== undefined && options.before !== null) {
    query = query.where("d.source_updated_at", "<", options.before);
  }
  const rows = await query.orderBy(due, (order) => order.asc().nullsLast())
    .orderBy("d.source_updated_at", "desc").orderBy("d.document_id", "desc").orderBy("c.claim_id")
    .limit(options.limit).execute();
  return uniqueClaims(rows).filter((row) => commitmentState(row.statement, row.status) !== "done"
    && !closedStatus(row.status));
}

interface OutdatedRow {
  readonly claim_id: string; readonly kind: BrainClaimKind; readonly statement: string; readonly document_id: string;
  readonly since: Date | string;
}

async function outdatedClaims(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, range: { readonly from: Date; readonly to: Date } | null,
): Promise<StaleItem[]> {
  const window = range === null ? sql`TRUE` : sql`x.since >= ${range.from} AND x.since < ${range.to}`;
  const { rows } = await sql<OutdatedRow>`
    SELECT * FROM (
      SELECT c.claim_id, c.kind, c.statement, c.document_id, COALESCE(v.superseded_at, d.updated_at) AS since
      FROM brain_claims c
      JOIN brain_documents d ON d.owner_id = c.owner_id AND d.scope_id = c.scope_id AND d.document_id = c.document_id
      LEFT JOIN brain_document_revisions v ON v.owner_id = c.owner_id AND v.scope_id = c.scope_id
        AND v.document_id = c.document_id AND v.incarnation = c.incarnation AND v.revision = c.revision
      WHERE c.owner_id = ${scope.ownerId} AND c.scope_id = ${scope.scopeId} AND d.deleted_at IS NULL
        AND (c.revision <> d.revision OR c.incarnation <> d.incarnation)
    ) x WHERE ${window}
    ORDER BY x.since DESC, x.claim_id LIMIT ${BRIEF_SCANS.staleItems}`.execute(db);
  return uniqueClaims(rows).map((row) => ({
    kind: "claim_outdated", text: lineText(`Outdated ${row.kind}: ${row.statement}`), since: iso(row.since),
    cite: null, sourceId: null, claimId: row.claim_id, key: row.claim_id, anchor: row.document_id,
    claimKind: row.kind, due: null, assignee: null,
  }));
}

async function overdueCommitments(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, before: string,
): Promise<StaleItem[]> {
  const rows = await openCommitments(db, scope, { dueBefore: before, limit: BRIEF_SCANS.staleItems });
  return rows.flatMap((row) => {
    const { due, assignee } = commitmentTerms(row);
    const day = due === null ? null : parseUtcDate(due);
    if (day === null) return [];
    return [{
      kind: "commitment_overdue" as const, text: lineText(`Overdue (due ${due}): ${row.statement}`),
      since: iso(new Date(day.getTime() + DAY_MS)), cite: null, sourceId: null,
      claimId: row.claim_id, key: row.claim_id, anchor: row.document_id, claimKind: "commitment" as const, due,
      assignee,
    }];
  });
}

async function staleSources(db: Kysely<BrainDatabase>, scope: BrainScopeKey, now: Date): Promise<StaleItem[]> {
  const items: StaleItem[] = [];
  for (const source of await sourceStates(db, scope)) {
    const base = {
      cite: null, sourceId: source.source_id, claimId: null, key: source.source_id,
      anchor: source.newest_document, claimKind: null, due: null, assignee: null,
    } as const;
    if (source.last_status === "failed" && source.last_finished !== null) {
      const code = source.last_error === null ? "" : ` (${source.last_error})`;
      items.push({ ...base, kind: "source_failing", since: iso(source.last_finished),
        text: lineText(`Source "${source.label}" failed its last sync${code}`) });
    }
    const last = new Date(source.last_success ?? source.created_at);
    const staleAt = last.getTime() + BRAIN_STALE_SOURCE_DAYS * DAY_MS;
    if (staleAt <= now.getTime()) {
      const what = source.last_success === null ? "since it was connected on" : "since";
      items.push({ ...base, kind: "source_sync_old", since: iso(new Date(staleAt)),
        text: lineText(`Source "${source.label}" has not synced successfully ${what} ${utcDate(last)}`) });
    }
  }
  return items;
}

export interface StaleOptions {
  readonly kinds: readonly BrainStaleKind[]; readonly now: Date;
  /** commitment_overdue: due before this YYYY-MM-DD. */
  readonly overdueBefore: string;
  /** claim_outdated: only claims that became outdated in this range. */
  readonly outdatedIn?: { readonly from: Date; readonly to: Date };
}

const kindOrder = (kind: BrainStaleKind): number => BRAIN_STALE_KINDS.indexOf(kind);

/** Newest `since` first, then kind order, then claim or source id. Claim items carry the live document's cite. */
export async function computeStale(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, options: StaleOptions,
): Promise<StaleItem[]> {
  const items: StaleItem[] = [];
  const { kinds } = options;
  if (kinds.includes("claim_outdated")) items.push(...await outdatedClaims(db, scope, options.outdatedIn ?? null));
  if (kinds.includes("commitment_overdue")) items.push(...await overdueCommitments(db, scope, options.overdueBefore));
  if (kinds.some((kind) => kind === "source_sync_old" || kind === "source_failing")) {
    items.push(...(await staleSources(db, scope, options.now)).filter((item) => kinds.includes(item.kind)));
  }
  const claimItems = items.filter((item) => item.claimId !== null);
  const cites = await loadCites(db, scope, claimItems.map((item) => item.anchor!));
  return items.flatMap((item) => {
    if (item.claimId === null) return [item];
    const cite = cites.get(item.anchor!);
    return cite === undefined ? [] : [{ ...item, cite }];
  }).sort((x, y) => y.since.localeCompare(x.since) || kindOrder(x.kind) - kindOrder(y.kind)
    || x.key.localeCompare(y.key));
}

/** The public view of an item. */
export function staleView(item: StaleItem): BrainStaleItemView {
  const { kind, text, since, cite, sourceId, claimId } = item;
  return { kind, text, since, cite, sourceId, claimId };
}
