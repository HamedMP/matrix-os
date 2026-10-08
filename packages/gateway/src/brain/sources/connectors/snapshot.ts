/**
 * Connector sources: the snapshot adapter used by Google Drive, Google Calendar and the Slack bridge. The first page of
 * a run lists the remote items (bounded), reads back this source's stored documents (bounded) and plans the work:
 * items whose stamp differs from the stored source_updated_at, every item when the render fingerprint changed, and
 * deletions for stored documents missing from a complete listing (or, with `retain`, the oldest ones past that
 * bound; with `sweepOnMigrate`, every one of them while a re-render is in progress; with `revoked`, every one, after
 * which the run fails with that code). Later pages of the run pop from that plan. A build that fails after the page built something ends the page with what it built; the next page
 * returns that failure without calling the provider again.
 *
 * Cursor ("<prefix>:" + base64url JSON): { v: 1, f: fingerprint, m: re-render (or its sweep) in progress, p: last
 * re-rendered [stamp, documentId] or null }: a progress marker only; the store decides what changed.
 */
import { z } from "zod/v4";
import type { BrainSourceAdapter, BrainSourceNotice, BrainSourceReadContext, BrainSourceReadResult } from "../../contracts.js";
import { BRAIN_DOCUMENT_ID_PATTERN, type BrainSyncUpsertInput } from "../../types.js";
import type { ConnectorResult } from "./provider.js";
import { decodeCursor, encodeCursor } from "./text.js";
import { BRAIN_CONNECTOR_LIMITS, type BrainConnectorKind } from "./types.js";

export interface SnapshotItem {
  readonly documentId: string;
  /** ISO-8601 UTC; becomes the document's source_updated_at. */
  readonly stamp: string;
}

export interface SnapshotListing<TItem extends SnapshotItem> {
  readonly items: readonly TItem[];
  /** False when a cap or a provider flag cut the listing: nothing is swept. */
  readonly complete: boolean;
  /** Document ids the provider reports as deleted (cancelled events); never ids of `items`. */
  readonly gone: readonly string[];
  readonly notices: readonly BrainSourceNotice[];
  /** Access to the remote side is gone: with an empty complete listing, sweep every stored item, then fail with it. */
  readonly revoked?: Extract<ConnectorResult<never>, { readonly ok: false }>;
}

export interface SnapshotBuild {
  /** Null: read but not written (skipped). */
  readonly upsert: BrainSyncUpsertInput | null;
  readonly notices: readonly BrainSourceNotice[];
}

export interface SnapshotSpec<TConfig, TItem extends SnapshotItem> {
  readonly kind: BrainConnectorKind;
  readonly cursorPrefix: string;
  /** Changes whenever the same item would render differently (config or render version). */
  readonly fingerprint: string;
  /** Items built per page (each build may be one provider call). */
  readonly buildsPerPage: number;
  /** Delete stored documents missing from a complete listing. */
  readonly sweep: boolean;
  /** Without sweep: keep at most this many documents, deleting stored ones missing from the listing oldest first. */
  readonly retain?: number;
  /** Sweep as `sweep` does, ignoring `retain`, while a fingerprint change is re-rendered (open until one is complete). */
  readonly sweepOnMigrate?: boolean;
  /** Stored documents read back per plan; default BRAIN_CONNECTOR_LIMITS.storedDocumentsMax. */
  readonly storedMax?: number;
  list(context: BrainSourceReadContext<TConfig>): Promise<ConnectorResult<SnapshotListing<TItem>>>;
  build(item: TItem, context: BrainSourceReadContext<TConfig>): Promise<ConnectorResult<SnapshotBuild>>;
}

const CursorSchema = z.object({
  v: z.literal(1), f: z.string().max(128), m: z.boolean(),
  p: z.tuple([z.string().max(64), z.string().regex(BRAIN_DOCUMENT_ID_PATTERN)]).nullable(),
}).strict();
type Position = readonly [string, string];

interface Plan<TItem extends SnapshotItem> {
  readonly pending: TItem[];
  readonly deletions: string[];
  notices: BrainSourceNotice[];
  readonly migrating: boolean;
  /** The sweepOnMigrate sweep could not run: the cursor keeps m. */
  readonly sweepPending: boolean;
  position: Position | null;
  halted: BrainSourceReadResult | null;
  /** Returned by the page after the last sweep page (access revoked). */
  readonly revoked: BrainSourceReadResult | null;
}

function compareKey(item: SnapshotItem, position: Position): number {
  if (item.stamp !== position[0]) return item.stamp < position[0] ? -1 : 1;
  return item.documentId < position[1] ? -1 : item.documentId > position[1] ? 1 : 0;
}

async function readStored<TConfig>(
  context: BrainSourceReadContext<TConfig>, storedMax: number,
): Promise<{ readonly stamps: Map<string, string>; readonly complete: boolean }> {
  const stamps = new Map<string, string>();
  let cursor: string | null = null;
  do {
    const page = await context.documents.listDocuments(context.scope, { sourceId: context.sourceId, limit: 100, cursor });
    for (const doc of page.items) stamps.set(doc.documentId, doc.sourceUpdatedAt);
    cursor = page.nextCursor;
    if (cursor !== null && stamps.size >= storedMax) return { stamps, complete: false };
  } while (cursor !== null);
  return { stamps, complete: true };
}

async function makePlan<TConfig, TItem extends SnapshotItem>(
  spec: SnapshotSpec<TConfig, TItem>, context: BrainSourceReadContext<TConfig>,
): Promise<ConnectorResult<Plan<TItem>>> {
  const cursor = decodeCursor(spec.cursorPrefix, context.cursor, CursorSchema);
  const same = cursor !== null && cursor.f === spec.fingerprint;
  const migrating = !same || cursor.m;
  const position = same ? cursor.p : null;
  const listed = await spec.list(context);
  if (!listed.ok) return listed;
  const stored = await readStored(context, spec.storedMax ?? BRAIN_CONNECTOR_LIMITS.storedDocumentsMax);
  const remote = new Map<string, TItem>();
  for (const item of listed.value.items) remote.set(item.documentId, item);
  const pending = [...remote.values()].filter((item) => stored.stamps.get(item.documentId) !== item.stamp
    || (migrating && (position === null || compareKey(item, position) > 0)));
  pending.sort((a, b) => compareKey(a, [b.stamp, b.documentId]));
  const deletions = new Set<string>();
  const complete = listed.value.complete && stored.complete;
  const migrationSweep = spec.sweepOnMigrate === true && migrating;
  if ((spec.sweep || migrationSweep) && complete) {
    for (const documentId of stored.stamps.keys()) if (!remote.has(documentId)) deletions.add(documentId);
  }
  for (const documentId of listed.value.gone) if (stored.stamps.has(documentId)) deletions.add(documentId);
  if (spec.retain !== undefined) {
    const history = [...stored.stamps].filter(([documentId]) => !remote.has(documentId) && !deletions.has(documentId))
      .sort(([id, stamp], [otherId, otherStamp]) => compareKey({ documentId: id, stamp }, [otherStamp, otherId]));
    const excess = remote.size + history.length - spec.retain;
    for (const [documentId] of history.slice(0, Math.max(0, excess))) deletions.add(documentId);
  }
  const notices = [...listed.value.notices];
  if (!stored.complete) notices.push("items_truncated");
  const revoked = listed.value.revoked ?? null;
  const plan = { pending, deletions: [...deletions], notices, migrating, position, halted: null, revoked };
  return { ok: true, value: { ...plan, sweepPending: migrationSweep && !complete } };
}

async function nextPage<TConfig, TItem extends SnapshotItem>(
  spec: SnapshotSpec<TConfig, TItem>, plan: Plan<TItem>, context: BrainSourceReadContext<TConfig>,
): Promise<BrainSourceReadResult> {
  if (plan.halted !== null) return plan.halted;
  const notices = plan.notices;
  plan.notices = [];
  const deletions = plan.deletions.splice(0, context.limits.maxDeletions);
  const upserts: BrainSyncUpsertInput[] = [];
  const cap = Math.max(1, Math.min(context.limits.maxUpserts, spec.buildsPerPage));
  let refs = 0;
  let skipped = 0;
  while (plan.pending.length > 0 && upserts.length + skipped < cap) {
    const item = plan.pending[0]!;
    const built = await spec.build(item, context);
    if (!built.ok && built.code !== "remote_not_found") {
      if (upserts.length + skipped === 0) return built;
      plan.halted = built;
      break;
    }
    const upsert = built.ok ? built.value.upsert : null;
    const size = upsert?.refs?.length ?? 0;
    if (upsert !== null && upserts.length > 0 && refs + size > context.limits.maxRefs) break;
    plan.pending.shift();
    if (plan.migrating) plan.position = [item.stamp, item.documentId];
    if (built.ok) notices.push(...built.value.notices);
    if (upsert === null) {
      skipped += 1;
      continue;
    }
    upserts.push(upsert);
    refs += size;
  }
  let caughtUp = plan.pending.length === 0 && plan.deletions.length === 0;
  if (caughtUp && plan.revoked !== null) {
    // The sweep commits with this page; the next page reports the lost access, so the source shows failing.
    plan.halted = plan.revoked;
    caughtUp = false;
  }
  const migrating = (plan.migrating && !caughtUp) || plan.sweepPending;
  const p = migrating ? plan.position : null;
  const nextCursor = encodeCursor(spec.cursorPrefix, { v: 1, f: spec.fingerprint, m: migrating, p });
  return { ok: true, page: { upserts, deletions, nextCursor, caughtUp, skipped, notices: [...new Set(notices)] } };
}

/** One instance per run keeps the run's plan; it plans again when the cursor is not the one it last returned. */
export function createSnapshotAdapter<TConfig, TItem extends SnapshotItem>(
  spec: SnapshotSpec<TConfig, TItem>,
): BrainSourceAdapter<TConfig> {
  let plan: Plan<TItem> | null = null;
  let lastCursor: string | null = null;
  return {
    kind: spec.kind,
    async readPage(context) {
      if (plan === null || context.cursor !== lastCursor) {
        const made = await makePlan(spec, context);
        if (!made.ok) return made;
        plan = made.value;
      }
      const result = await nextPage(spec, plan, context);
      lastCursor = result.ok ? result.page.nextCursor : null;
      return result;
    },
  };
}
