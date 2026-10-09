/**
 * Meaning search on a PGlite with the pgvector extension: bootstrap, the chunks table and the real vector store, a
 * switch between the array and pgvector stores, stale writes (revision or claims set) and vectors read back by text
 * key.
 */
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { BrainStoreError } from "../../packages/gateway/src/brain/index.js";
import {
  bootstrapBrainSearchDatabase, createBrainPgVectorStore, createBrainSearch,
} from "../../packages/gateway/src/brain/search/index.js";
import { brainDocumentId } from "./helpers/brain-store-helpers.js";
import {
  OWNER, PROJECT_ID, SCOPE, createSearchHarness, createSeeder, fakeProvider, fakeVector, resolver, type SearchHarness,
} from "./helpers/brain-search-fakes.js";

describe("brain search pgvector", { timeout: 60_000 }, () => {
  let h: SearchHarness;
  let error: MockInstance<typeof console.error>;
  const trace: string[] = [];
  beforeEach(async () => {
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h = await createSearchHarness({ vector: true, trace });
  });
  afterEach(async () => { error.mockRestore(); await h.destroy(); });

  it("needs a provider, then embeds and searches through the default store under deadlines, inside the scope", async () => {
    expect(h.capability).toEqual({ fullText: true, vector: "provider_not_configured", providerId: null });
    expect(await bootstrapBrainSearchDatabase(h.db)).toEqual(h.capability);
    expect(createBrainSearch({ repository: h.repository, resolver, capability: h.capability }).service.capability().vector)
      .toBe("provider_not_configured");
    const feature = createBrainSearch({ repository: h.repository, resolver, capability: h.capability,
      embeddings: fakeProvider(), now: h.now });
    expect(feature.service.capability()).toEqual({ fullText: true, vector: "available", providerId: "fake-embed",
      store: "pgvector" });
    const other = { ownerId: "owner_b", scopeId: SCOPE.scopeId };
    const mine = await createSeeder(h);
    await mine.sync([{ seed: "garden", title: "mine", body: "kittens and gardens" }, { seed: "ledger", body: "kittens ledger" }]);
    await (await createSeeder(h, other)).sync([{ seed: "garden", title: "theirs", body: "kittens and gardens" },
      { seed: "only", body: "kittens ledger" }]);
    trace.length = 0;
    expect(await feature.index.refresh(other, {}, AbortSignal.timeout(30_000))).toMatchObject({ processed: 2, caughtUp: true });
    expect(await feature.service.refresh(OWNER, PROJECT_ID)).toMatchObject({ processed: 2, caughtUp: true });
    const view = await feature.service.search(OWNER, PROJECT_ID, { q: "kittens", mode: "hybrid" });
    expect(view.items.map((item) => [item.hitId, item.cite.title, item.matchedBy]).sort()).toEqual([
      [brainDocumentId("garden"), "mine", ["text", "vector"]], [brainDocumentId("ledger"), "Title ledger", ["text", "vector"]],
    ].sort());
    await feature.index.handle({ type: "scope_erased", scope: SCOPE, at: h.iso() }, AbortSignal.timeout(30_000));
    expect(await feature.index.freshness(other)).toMatchObject({ caughtUp: true });
    let open = false;
    let deadline = false;
    for (const statement of trace) {
      if (statement === "BEGIN") [open, deadline] = [true, false];
      else if (statement === "COMMIT" || statement === "ROLLBACK") open = false;
      else if (statement.includes("statement_timeout")) deadline = open;
      else if (!statement.startsWith("SET ")) expect({ statement, open, deadline }).toEqual({ statement, open: true, deadline: true });
    }
    const chunks = await sql<{ owner_id: string; n: number }>`SELECT owner_id, count(*)::int AS n FROM brain_search_chunks
      GROUP BY owner_id ORDER BY owner_id`.execute(h.db);
    expect(chunks.rows).toEqual([{ owner_id: OWNER, n: 2 }, { owner_id: "owner_b", n: 2 }]);
    await mine.sync([], ["garden"]);
    expect((await createBrainPgVectorStore(h.db).nearest(SCOPE, fakeVector("kittens gardens"), 10, "fake-embed"))
      .map((match) => match.documentId)).toEqual([brainDocumentId("ledger")]);
  });

  it("embeds again when the store changes from arrays to pgvector", async () => {
    const provider = fakeProvider();
    const arrays = createBrainSearch({ repository: h.repository, resolver, now: h.now, embeddings: provider,
      capability: { ...h.capability, vector: "extension_missing" } });
    await (await createSeeder(h)).sync([{ seed: "a", body: "kittens" }]);
    expect(await arrays.service.refresh(OWNER, PROJECT_ID)).toMatchObject({ processed: 1, caughtUp: true });
    const pg = createBrainSearch({ repository: h.repository, resolver, capability: h.capability, embeddings: provider,
      now: h.now });
    expect(pg.service.capability()).toMatchObject({ vector: "available", store: "pgvector" });
    expect(await pg.index.freshness(SCOPE)).toMatchObject({ caughtUp: false, pendingDocuments: 1 });
    expect(await pg.service.refresh(OWNER, PROJECT_ID)).toMatchObject({ processed: 1, caughtUp: true });
    const view = await pg.service.search(OWNER, PROJECT_ID, { q: "kittens", mode: "hybrid" });
    expect(view.items.map((item) => item.matchedBy)).toEqual([["text", "vector"]]);
    const rows = await sql<{ n: number }>`SELECT count(text_key)::int AS n FROM brain_search_chunks`.execute(h.db);
    expect(rows.rows).toEqual([{ n: 1 }]);
  });

  it("validates input, replaces chunks and skips zero vectors", async () => {
    const store = createBrainPgVectorStore(h.db);
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a", body: "alpha" }]);
    const document = (await h.repository.getDocument(SCOPE, brainDocumentId("a")))!;
    const replace = (chunks: { spanStart: number; spanEnd: number; vector: number[]; textKey?: string }[],
      providerId = "fake-embed") =>
      store.replaceChunks(SCOPE, { documentId: document.documentId, incarnation: document.incarnation,
        revision: document.revision, providerId, chunks });
    await replace([{ spanStart: 0, spanEnd: 5, vector: [0, 0, 0] }]);
    expect(await store.nearest(SCOPE, [1, 0, 0], 5, "fake-embed")).toEqual([]);
    await replace([{ spanStart: 0, spanEnd: 5, vector: [1, 0, 0] }, { spanStart: 2, spanEnd: 5, vector: [0, 1, 0] }]);
    const at = { documentId: document.documentId, incarnation: document.incarnation, revision: document.revision };
    expect(await store.nearest(SCOPE, [1, 0, 0], 5, "fake-embed")).toEqual([
      { ...at, chunkIndex: 0, distance: 0 }, { ...at, chunkIndex: 1, distance: 1 }]);
    expect(await store.nearest(SCOPE, [1, 0], 5, "fake-embed")).toEqual([]);
    await replace([]);
    expect(await store.nearest(SCOPE, [1, 0, 0], 5, "fake-embed")).toEqual([]);
    const key = "a".repeat(32);
    await replace([{ spanStart: 0, spanEnd: 5, vector: [0, 3, 4], textKey: key }]);
    expect(await store.storedVectors!(SCOPE, { providerId: "fake-embed", dimensions: 3,
      documentIds: [document.documentId], textKeys: [key] })).toEqual(new Map([[key, [0, 3, 4]]]));
    // A write for an older revision changes nothing.
    await seeder.sync([{ seed: "a", body: "alpha revised" }]);
    await replace([{ spanStart: 0, spanEnd: 5, vector: [1, 0, 0] }]);
    expect((await sql<{ text_key: string }>`SELECT text_key FROM brain_search_chunks`.execute(h.db)).rows)
      .toEqual([{ text_key: key }]);
    for (const bad of [
      () => replace([{ spanStart: 3, spanEnd: 2, vector: [1] }]), () => replace([], "Bad Id"),
      () => replace([{ spanStart: 0, spanEnd: 1, vector: [1] }, { spanStart: 0, spanEnd: 1, vector: [1, 2] }]),
      () => replace([{ spanStart: 0, spanEnd: 1, vector: [Number.NaN] }]),
      () => replace([{ spanStart: 0, spanEnd: 1, vector: [1e39] }]), () => store.nearest(SCOPE, [-1e39], 1, "fake-embed"),
      () => store.nearest(SCOPE, [1], 0, "fake-embed"), () => store.nearest(SCOPE, [], 1, "fake-embed"),
      () => store.nearest({ ownerId: "", scopeId: "x" }, [1], 1, "fake-embed"),
    ]) await expect(bad()).rejects.toBeInstanceOf(BrainStoreError);
  });

  it("skips a write for another claims set than the document's search row holds", async () => {
    const store = createBrainPgVectorStore(h.db);
    await (await createSeeder(h)).sync([{ seed: "a", body: "alpha" }]);
    await createBrainSearch({ repository: h.repository, resolver, capability: h.capability, now: h.now })
      .service.refresh(OWNER, PROJECT_ID);
    const claimsKey = (await sql<{ claims_key: string }>`SELECT claims_key FROM brain_search_documents
      WHERE document_id = ${brainDocumentId("a")}`.execute(h.db)).rows[0]!.claims_key;
    const document = (await h.repository.getDocument(SCOPE, brainDocumentId("a")))!;
    const chunks = async () => Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM brain_search_chunks`
      .execute(h.db)).rows[0]!.n);
    const write = (key: string) => store.replaceChunks(SCOPE, { documentId: document.documentId,
      incarnation: document.incarnation, revision: document.revision, providerId: "fake-embed", claimsKey: key,
      chunks: [{ spanStart: 0, spanEnd: 5, vector: [1, 0, 0] }] });
    await write("f".repeat(32));
    expect(await chunks()).toBe(0);
    await write(claimsKey);
    expect(await chunks()).toBe(1);
    await expect(write("XYZ")).rejects.toBeInstanceOf(BrainStoreError);
  });

  it("skips a removal while the document is live at another revision, so a late sweep keeps restored chunks", async () => {
    const store = createBrainPgVectorStore(h.db);
    const seeder = await createSeeder(h);
    const chunks = async () => Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM brain_search_chunks`
      .execute(h.db)).rows[0]!.n);
    await seeder.sync([{ seed: "a", body: "alpha" }]);
    await seeder.sync([], ["a"]);
    const tombstone = (await sql<{ incarnation: string; revision: number }>`SELECT incarnation, revision
      FROM brain_documents WHERE document_id = ${brainDocumentId("a")}`.execute(h.db)).rows[0]!;
    await seeder.sync([{ seed: "a", body: "alpha restored" }]);
    const live = (await h.repository.getDocument(SCOPE, brainDocumentId("a")))!;
    await store.replaceChunks(SCOPE, { documentId: live.documentId, incarnation: live.incarnation,
      revision: live.revision, providerId: "fake-embed", chunks: [{ spanStart: 0, spanEnd: 5, vector: [1, 0, 0] }] });
    const remove = () => store.replaceChunks(SCOPE, { documentId: brainDocumentId("a"), ...tombstone,
      providerId: "fake-embed", chunks: [] });
    await remove();
    expect(await chunks()).toBe(1);
    await seeder.sync([], ["a"]);
    await remove();
    expect(await chunks()).toBe(0);
  });
});
