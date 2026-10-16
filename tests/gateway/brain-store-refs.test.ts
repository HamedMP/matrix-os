import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRAIN_DOCUMENT_REFS_MAX, BRAIN_REF_VALUE_MAX_BYTES, BRAIN_SYNC_BATCH_MAX_REFS,
  type BrainDocumentRef, type BrainSyncBatchInput,
} from "../../packages/gateway/src/brain/index.js";
import {
  GIT_MAX_REFS_PER_DOCUMENT, GIT_REF_VALUE_MAX_BYTES, GIT_SYNC_LIMIT_CEILINGS,
} from "../../packages/gateway/src/brain/git/types.js";
import {
  brainContent, brainDocumentId, countBrainRows, createBrainHarness, expectBrainError, manualDocument,
  scopeA, scopeB, type BrainHarness,
} from "./helpers/brain-store-helpers.js";

const path = (value: string): BrainDocumentRef => ({ kind: "path", value });
function batch(sourceId: string, overrides: Partial<BrainSyncBatchInput> = {}): BrainSyncBatchInput {
  return { sourceId, expectedCursor: null, nextCursor: "c1", upserts: [], deletions: [], ...overrides };
}

describe("brain document refs", () => {
  let harness: BrainHarness;
  beforeEach(async () => { harness = await createBrainHarness(); });
  afterEach(() => harness.destroy());

  async function xmins(): Promise<string[]> {
    const rows = await sql<{ x: string }>`SELECT xmin::text AS x FROM brain_document_refs ORDER BY value`.execute(harness.db);
    return rows.rows.map((row) => row.x);
  }

  it("keeps the git adapter's ref limits inside the store's", () => {
    expect(GIT_MAX_REFS_PER_DOCUMENT).toBeLessThanOrEqual(BRAIN_DOCUMENT_REFS_MAX);
    expect(GIT_REF_VALUE_MAX_BYTES).toBe(BRAIN_REF_VALUE_MAX_BYTES);
    expect(GIT_SYNC_LIMIT_CEILINGS.refsPerBatch).toBeLessThanOrEqual(BRAIN_SYNC_BATCH_MAX_REFS);
  });

  it("writes, compares, replaces and clears refs with the document lifecycle", async () => {
    const { repository, db } = harness;
    const { source } = await repository.createSource(scopeA, { kind: "git", externalRef: "https://github.com/o/r", label: "r" });
    const { source: other } = await repository.createSource(scopeA, { kind: "git", externalRef: "https://github.com/o/s", label: "s" });
    const pr = brainContent("pr", { provenance: "git_pr" });
    const refs = [path("b.ts"), path("a.ts"), { kind: "spec", value: "551-company-brain-store" }];
    await repository.applySyncBatch(scopeA, batch(source.sourceId, { upserts: [{ ...pr, refs }] }));
    expect(await repository.listDocumentRefs(scopeA, pr.documentId)).toEqual([path("a.ts"), path("b.ts"), refs[2]]);
    expect(await repository.listDocumentRefs(scopeB, pr.documentId)).toEqual([]);

    const before = await xmins();
    const replay = await repository.applySyncBatch(scopeA, batch(source.sourceId, {
      expectedCursor: "c1", upserts: [{ ...pr, refs: [...refs].reverse() }],
    }));
    expect(replay.unchanged).toBe(1);
    expect(await xmins()).toEqual(before);

    const refsOnly = await repository.applySyncBatch(scopeA, batch(source.sourceId, {
      expectedCursor: "c1", upserts: [{ ...pr, refs: [path("c.ts")] }],
    }));
    expect(refsOnly).toMatchObject({ unchanged: 1, updated: 0 });
    expect((await repository.getDocument(scopeA, pr.documentId))?.revision).toBe(1);
    expect(await repository.listDocumentRefs(scopeA, pr.documentId)).toEqual([path("c.ts")]);

    await repository.reviseDocument(scopeA, { documentId: pr.documentId, expectedRevision: 1, body: "edited" });
    expect(await repository.listDocumentRefs(scopeA, pr.documentId)).toEqual([path("c.ts")]);

    const foreign = await repository.applySyncBatch(scopeA, batch(other.sourceId, { nextCursor: "o1", upserts: [{ ...pr, refs: [] }] }));
    expect(foreign.rejected).toEqual([pr.documentId]);
    expect(await repository.listDocumentRefs(scopeA, pr.documentId)).toEqual([path("c.ts")]);

    await repository.applySyncBatch(scopeA, batch(source.sourceId, { expectedCursor: "c1", nextCursor: "c2", upserts: [pr] }));
    expect(await repository.listDocumentRefs(scopeA, pr.documentId)).toEqual([]);

    const both = brainContent("both");
    await repository.applySyncBatch(scopeA, batch(source.sourceId, {
      expectedCursor: "c2", nextCursor: "c3", upserts: [{ ...pr, body: "v3", refs: [path("x")] }, { ...both, refs: [path("y")] }],
      deletions: [both.documentId],
    }));
    expect(await repository.listDocumentRefs(scopeA, both.documentId)).toEqual([]);
    await repository.applySyncBatch(scopeA, batch(source.sourceId, { expectedCursor: "c3", nextCursor: "c4", deletions: [pr.documentId] }));
    expect(await countBrainRows(db, "brain_document_refs", scopeA)).toBe(0);

    await repository.applySyncBatch(scopeA, batch(source.sourceId, { expectedCursor: "c4", nextCursor: "c5", upserts: [{ ...pr, refs: [path("z")] }] }));
    expect(await repository.listDocumentRefs(scopeA, pr.documentId)).toEqual([path("z")]);
    await repository.deleteDocument(scopeA, { documentId: pr.documentId });
    expect(await countBrainRows(db, "brain_document_refs", scopeA)).toBe(0);
  });

  it("removes refs on deleteSource and eraseScope only for the affected documents", async () => {
    const { repository, db } = harness;
    const { source: a } = await repository.createSource(scopeA, { kind: "git", externalRef: "A", label: "A" });
    const { source: b } = await repository.createSource(scopeA, { kind: "git", externalRef: "B", label: "B" });
    const { source: inB } = await repository.createSource(scopeB, { kind: "git", externalRef: "A", label: "A" });
    await repository.applySyncBatch(scopeA, batch(a.sourceId, { upserts: [{ ...brainContent("a"), refs: [path("a")] }] }));
    await repository.applySyncBatch(scopeA, batch(b.sourceId, { upserts: [{ ...brainContent("b"), refs: [path("b")] }] }));
    await repository.applySyncBatch(scopeB, batch(inB.sourceId, { upserts: [{ ...brainContent("a"), refs: [path("a")] }] }));
    await repository.deleteSource(scopeA, { sourceId: a.sourceId, expectedRevision: 1 });
    expect(await repository.listDocumentRefs(scopeA, brainDocumentId("a"))).toEqual([]);
    expect(await repository.listDocumentRefs(scopeA, brainDocumentId("b"))).toEqual([path("b")]);
    await repository.eraseScope(scopeA);
    expect(await countBrainRows(db, "brain_document_refs", scopeA)).toBe(0);
    expect(await countBrainRows(db, "brain_document_refs", scopeB)).toBe(1);
  });

  it("bounds refs and rolls them back with the batch", async () => {
    const capped = await createBrainHarness({ maxDocumentsPerScope: 1 });
    try {
      const { repository, db } = capped;
      const { source } = await repository.createSource(scopeA, { kind: "git", externalRef: "R", label: "R" });
      const one = brainContent("one");
      const invalid = async (refs: readonly BrainDocumentRef[]) =>
        expectBrainError(repository.applySyncBatch(scopeA, batch(source.sourceId, { upserts: [{ ...one, refs }] })), "invalid");
      await invalid(Array.from({ length: 201 }, (_, index) => path(`f${index}`)));
      await invalid([path("a"), path("a")]);
      await invalid([{ kind: "Path", value: "a" }]);
      await invalid([path("")]);
      await invalid([path("a\u0000b")]);
      await invalid([path("\u00e9".repeat(257))]);
      await invalid([{ ...path("a"), extra: 1 } as never]);
      await expectBrainError(repository.applySyncBatch(scopeA, batch(source.sourceId, {
        upserts: Array.from({ length: 51 }, (_, d) => ({
          ...brainContent(`d${d}`), refs: Array.from({ length: 200 }, (_, r) => path(`f${r}`)),
        })),
      })), "invalid");
      await expectBrainError(repository.applySyncBatch(scopeA, batch(source.sourceId, {
        upserts: [{ ...one, refs: [path("a")] }, { ...brainContent("two"), refs: [path("b")] }],
      })), "capacity");
      expect(await countBrainRows(db, "brain_document_refs", scopeA)).toBe(0);
      await repository.applySyncBatch(scopeA, batch(source.sourceId, { upserts: [{ ...one, refs: [path("\u00e9".repeat(256))] }] }));
      expect(await countBrainRows(db, "brain_document_refs", scopeA)).toBe(1);
      await repository.upsertDocument(scopeB, manualDocument("m"));
    } finally {
      await capped.destroy();
    }
  });
});
