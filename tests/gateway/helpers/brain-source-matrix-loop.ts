/**
 * A small sync loop for the Matrix source adapters: reads pages from an adapter and applies each one with
 * applySyncBatch, as the shared runner does, checking provenance, ref kinds and the page limits on the way.
 */
import { expect } from "vitest";
import {
  BRAIN_REF_KINDS, BRAIN_SOURCE_KIND_PROVENANCES, type BrainSourceAdapter, type BrainSourceNotice,
  type BrainSourcePageLimits, type BrainSourceReadResult,
} from "../../../packages/gateway/src/brain/contracts.js";
import type { BrainScopeKey } from "../../../packages/gateway/src/brain/index.js";
import type { BrainHarness } from "./brain-store-helpers.js";

export const matrixScope: BrainScopeKey = { ownerId: "owner_a", scopeId: "personal:project:proj_a" };
export const wideLimits: BrainSourcePageLimits = { maxUpserts: 100, maxDeletions: 100, maxRefs: 5_000 };

export interface MatrixLoopResult {
  readonly pages: number;
  readonly caughtUp: boolean;
  readonly notices: BrainSourceNotice[];
  readonly skipped: number;
  readonly written: number;
  readonly deleted: number;
  readonly failure: Extract<BrainSourceReadResult, { ok: false }> | null;
}

export async function createMatrixSource(harness: BrainHarness, kind: string, externalRef: string): Promise<string> {
  const { source } = await harness.repository.createSource(matrixScope, { kind, externalRef, label: kind });
  return source.sourceId;
}

export async function runMatrixLoop<T>(
  harness: BrainHarness, sourceId: string, externalRef: string, adapter: BrainSourceAdapter<T>, config: T,
  options: { readonly limits?: BrainSourcePageLimits; readonly maxPages?: number; readonly signal?: AbortSignal } = {},
): Promise<MatrixLoopResult> {
  const notices: BrainSourceNotice[] = [];
  let pages = 0, skipped = 0, written = 0, deleted = 0;
  const allowedRefs: readonly string[] = Object.values(BRAIN_REF_KINDS);
  const limits = options.limits ?? wideLimits;
  while (pages < (options.maxPages ?? 200)) {
    const cursor = (await harness.repository.getSyncCursor(matrixScope, sourceId))?.cursor ?? null;
    const result = await adapter.readPage({
      scope: matrixScope, sourceId, externalRef, config, cursor, limits,
      signal: options.signal ?? new AbortController().signal, documents: harness.repository, now: harness.now,
    });
    if (!result.ok) return { pages, caughtUp: false, notices, skipped, written, deleted, failure: result };
    const { page } = result;
    expect(page.upserts.length).toBeLessThanOrEqual(limits.maxUpserts);
    expect(page.deletions.length).toBeLessThanOrEqual(limits.maxDeletions);
    expect(page.upserts.reduce((sum, upsert) => sum + (upsert.refs?.length ?? 0), 0)).toBeLessThanOrEqual(limits.maxRefs);
    for (const upsert of page.upserts) {
      expect(BRAIN_SOURCE_KIND_PROVENANCES[adapter.kind]).toContain(upsert.provenance);
      for (const ref of upsert.refs ?? []) expect(allowedRefs).toContain(ref.kind);
    }
    const batch = await harness.repository.applySyncBatch(matrixScope, {
      sourceId, expectedCursor: cursor, nextCursor: page.nextCursor, upserts: page.upserts, deletions: page.deletions,
    });
    pages += 1;
    skipped += page.skipped;
    written += batch.created + batch.updated;
    deleted += batch.deleted;
    for (const notice of page.notices) if (!notices.includes(notice)) notices.push(notice);
    if (page.caughtUp) return { pages, caughtUp: true, notices, skipped, written, deleted, failure: null };
  }
  return { pages, caughtUp: false, notices, skipped, written, deleted, failure: null };
}

export async function liveTitles(harness: BrainHarness, sourceId: string): Promise<string[]> {
  const page = await harness.repository.listDocuments(matrixScope, { sourceId, limit: 100 });
  return page.items.map((item) => item.title).sort();
}
