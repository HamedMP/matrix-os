/**
 * Git source adapter: packs one window's upserts and deletions into
 * applySyncBatch calls within the store's per-batch caps. Pure. Only the
 * last batch of a window is `final`; sync.ts advances the cursor on it alone.
 */
import { BRAIN_SYNC_BATCH_MAX_ITEMS } from "../index.js";
import {
  GIT_SYNC_LIMIT_CEILINGS,
  GitSourceError,
  type GitBatchPlan,
  type GitSyncLimits,
  type GitUpsertDraft,
} from "./types.js";

interface DraftBatch {
  readonly upserts: GitUpsertDraft[];
  readonly deletions: string[];
  refs: number;
}

function emptyBatch(): DraftBatch {
  return { upserts: [], deletions: [], refs: 0 };
}

function assertDisjoint(upserts: readonly GitUpsertDraft[], deletions: readonly string[]): void {
  const ids = new Set<string>();
  for (const upsert of upserts) {
    if (ids.has(upsert.documentId)) throw new GitSourceError("document_invalid");
    ids.add(upsert.documentId);
  }
  for (const documentId of deletions) {
    if (ids.has(documentId)) throw new GitSourceError("document_invalid");
    ids.add(documentId);
  }
}

/**
 * Upserts are packed greedily in order: a batch closes at upsertsPerBatch
 * upserts, or before an upsert whose refs would push it over refsPerBatch
 * (a batch always takes at least one upsert). Deletions fill the last batch
 * up to the store cap, then spill into deletion-only batches. Nothing to
 * write still yields one empty batch, so the cursor can advance.
 */
export function planWindowBatches(
  upserts: readonly GitUpsertDraft[],
  deletions: readonly string[],
  limits: Pick<GitSyncLimits, "upsertsPerBatch" | "refsPerBatch">,
): GitBatchPlan[] {
  assertDisjoint(upserts, deletions);
  const upsertCap = Math.max(1, Math.min(limits.upsertsPerBatch, GIT_SYNC_LIMIT_CEILINGS.upsertsPerBatch, BRAIN_SYNC_BATCH_MAX_ITEMS));
  const refCap = Math.max(1, Math.min(limits.refsPerBatch, GIT_SYNC_LIMIT_CEILINGS.refsPerBatch));
  const batches: DraftBatch[] = [];
  let current = emptyBatch();
  for (const upsert of upserts) {
    const full = current.upserts.length >= upsertCap || current.refs + upsert.refs.length > refCap;
    if (current.upserts.length > 0 && full) {
      batches.push(current);
      current = emptyBatch();
    }
    current.upserts.push(upsert);
    current.refs += upsert.refs.length;
  }
  batches.push(current);
  let next = 0;
  while (next < deletions.length && current.deletions.length < BRAIN_SYNC_BATCH_MAX_ITEMS) {
    current.deletions.push(deletions[next]!);
    next += 1;
  }
  while (next < deletions.length) {
    const spill = emptyBatch();
    spill.deletions.push(...deletions.slice(next, next + BRAIN_SYNC_BATCH_MAX_ITEMS));
    next += spill.deletions.length;
    batches.push(spill);
  }
  return batches.map((batch, index) => ({
    upserts: batch.upserts,
    deletions: batch.deletions,
    final: index === batches.length - 1,
  }));
}
