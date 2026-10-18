/** Search bootstrap and derived index over PGlite: rebuilds, freshness, claims, orphans, hooks, embeddings, limits. */
import { sql, type KyselyPlugin, type RootOperationNode } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { rebuildDocuments, withSearchScopeWrite } from "../../packages/gateway/src/brain/search/index-sql.js";
import { createBrainSearchIndex } from "../../packages/gateway/src/brain/search/indexer.js";
import { bootstrapBrainSearchDatabase } from "../../packages/gateway/src/brain/search/index.js";
import { brainDocumentId } from "./helpers/brain-store-helpers.js";
import {
  SCOPE, createSearchHarness, createSeeder, fakeProvider, fakeVector, fakeVectorStore, seedClaims, type SearchHarness,
} from "./helpers/brain-search-fakes.js";

const signal = () => new AbortController().signal;
/** The embedding part of a refresh result with a provider that reports no usage. */
const NONE = { tokens: 0, costMicroUsd: 0, stopped: null };
const rows = async (h: SearchHarness, table: string) => Number((await sql<{ n: number }>`
  SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE owner_id = ${SCOPE.ownerId}`.execute(h.db)).rows[0]!.n);

/** Rewrites the extension statement, so the bootstrap meets another failure. */
const extensionAs = (replacement: string): KyselyPlugin => ({
  transformQuery: ({ node }) => (node.kind === "RawNode" && node.sqlFragments.join("").includes("CREATE EXTENSION")
    ? { ...node, sqlFragments: [replacement], parameters: [] } as RootOperationNode : node),
  transformResult: async ({ result }) => result,
});

describe("brain search index", { timeout: 60_000 }, () => {
  let h: SearchHarness;
  let warn: MockInstance<typeof console.warn>;
  let error: MockInstance<typeof console.error>;
  beforeEach(async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h = await createSearchHarness();
  });
  afterEach(async () => { vi.restoreAllMocks(); await h.destroy(); });

  it("bootstraps idempotently and reports a missing extension, but rethrows other failures", async () => {
    expect(h.capability).toEqual({ fullText: true, vector: "extension_missing", providerId: null });
    expect(await bootstrapBrainSearchDatabase(h.db)).toEqual(h.capability);
    expect(warn).toHaveBeenCalledWith("[brain-search] pgvector unavailable, full-text search only:", "0A000");
    // Search rows reference brain_documents only, so no search write ever locks a claim row.
    const fks = await sql<{ r: string }>`SELECT confrelid::regclass::text AS r FROM pg_constraint
      WHERE contype = 'f' AND conrelid::regclass::text LIKE 'brain_search%'`.execute(h.db);
    expect(fks.rows.map((row) => row.r)).toEqual(["brain_documents", "brain_documents", "brain_documents"]);
    const denied = h.db.withPlugin(extensionAs("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '42501'; END $$"));
    expect((await bootstrapBrainSearchDatabase(denied)).vector).toBe("extension_missing");
    await expect(bootstrapBrainSearchDatabase(h.db.withPlugin(extensionAs("SELECT 1/0")))).rejects.toMatchObject({ code: "22012" });
  });

  it("rebuilds missing, revised and re-extracted documents, reports freshness and stops at limits", async () => {
    const index = createBrainSearchIndex({ db: h.db, meaning: null, now: h.now });
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a", body: "Keep one transaction per document." }, { seed: "b" }]);
    expect(await index.freshness(SCOPE)).toEqual({ caughtUp: false, pendingDocuments: 2, pendingCapped: false });
    expect(await index.refresh(SCOPE, { budgetMs: 1 }, AbortSignal.abort())).toEqual({ processed: 0, removed: 0, caughtUp: false });
    expect(await index.refresh(SCOPE, { documents: 1 }, signal())).toEqual({ processed: 1, removed: 0, caughtUp: false });
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 1, removed: 0, caughtUp: true });
    expect(await index.freshness(SCOPE)).toEqual({ caughtUp: true, pendingDocuments: 0, pendingCapped: false });
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 0, removed: 0, caughtUp: true });

    await seedClaims(h, "a", [{ kind: "invariant", label: "Lock", statement: "one transaction", quote: "one transaction" }]);
    expect((await index.freshness(SCOPE)).pendingDocuments).toBe(1);
    expect(await index.refresh(SCOPE, { documents: 0.5, budgetMs: Number.NaN }, signal())).toMatchObject({ processed: 1 });
    expect(await rows(h, "brain_search_claims")).toBe(1);
    await seeder.sync([{ seed: "b", body: "revised" }]);
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 1, removed: 0, caughtUp: true });
    await seedClaims(h, "a", []);
    expect(await index.refresh(SCOPE, {}, signal())).toMatchObject({ processed: 1, caughtUp: true });
    expect(await rows(h, "brain_search_claims")).toBe(0);
  });

  it("drops claim rows and chunks of tombstoned documents, also after a skipped rebuild or a failed sweep", async () => {
    const vectors = await fakeVectorStore(h);
    const index = createBrainSearchIndex({ db: h.db, meaning: { provider: fakeProvider(), vectors }, now: h.now });
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a", body: "one transaction" }, { seed: "b" }, { seed: "c", body: "one lock" }]);
    for (const [seed, quote] of [["a", "one transaction"], ["c", "one lock"]] as const) {
      await seedClaims(h, seed, [{ kind: "invariant", statement: quote, quote }]);
    }
    await index.refresh(SCOPE, {}, signal());
    await seeder.sync([], ["a", "b", "c"]);
    // c: claim rows left without their document row; b: a rebuild that found its document gone.
    await sql`DELETE FROM brain_search_documents WHERE document_id = ${brainDocumentId("c")}`.execute(h.db);
    await withSearchScopeWrite(h.db, SCOPE, (trx) => rebuildDocuments(trx, SCOPE, [brainDocumentId("b")], h.now()));
    const replaceChunks = vectors.replaceChunks;
    vectors.replaceChunks = async () => { throw new Error("db down"); };
    await expect(index.refresh(SCOPE, {}, signal())).rejects.toThrow("db down");
    vectors.replaceChunks = replaceChunks;
    expect(await index.refresh(SCOPE, { documents: 2 }, signal()))
      .toEqual({ processed: 0, removed: 2, caughtUp: false, embedding: NONE });
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 0, removed: 1, caughtUp: true, embedding: NONE });
    expect(vectors.replaced.filter((entry) => entry.endsWith(":0")).sort())
      .toEqual(["a", "b", "c"].map((seed) => `${brainDocumentId(seed)}:0`).sort());
    expect([await rows(h, "brain_search_documents"), await rows(h, "brain_search_claims")]).toEqual([0, 0]);
  });

  it("reacts to hooks: listed ids, unknown sets, nothing to do, scope erase", async () => {
    const index = createBrainSearchIndex({ db: h.db, meaning: null, now: h.now });
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a" }, { seed: "b" }]);
    const at = h.iso();
    await index.handle({ type: "documents_changed", scope: SCOPE, sourceId: null, documentIds: [brainDocumentId("a"), "junk"], at }, signal());
    expect(await index.freshness(SCOPE)).toMatchObject({ pendingDocuments: 1 });
    await index.handle({ type: "documents_changed", scope: SCOPE, sourceId: null, documentIds: ["junk"], at }, signal());
    await index.handle({ type: "claims_changed", scope: SCOPE, extractor: "rules/v1", documentIds: null, at }, signal());
    expect(await rows(h, "brain_search_documents")).toBe(2);
    await index.handle({ type: "scope_erased", scope: SCOPE, at }, signal());
    expect(await rows(h, "brain_search_documents")).toBe(0);
    await h.repository.eraseScope(SCOPE);
    await index.handle({ type: "scope_erased", scope: SCOPE, at }, signal());
  });

  it("skips a document that a foreign key refuses and rethrows any other failure", async () => {
    const index = createBrainSearchIndex({ db: h.db, meaning: null, now: h.now });
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a" }, { seed: "b" }]);
    await sql.raw(`CREATE FUNCTION test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE = current_setting('test.code'); END $$`).execute(h.db);
    await sql.raw(`CREATE TRIGGER test_refuse BEFORE INSERT ON brain_search_documents
      FOR EACH ROW EXECUTE FUNCTION test_refuse()`).execute(h.db);
    await sql`SELECT set_config('test.code', '23503', false)`.execute(h.db);
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 0, removed: 0, caughtUp: false });
    await sql`SELECT set_config('test.code', '22012', false)`.execute(h.db);
    await expect(index.refresh(SCOPE, {}, signal())).rejects.toMatchObject({ code: "22012" });
  });

  it("embeds rebuilt documents into the vector store and keeps failures pending", async () => {
    const provider = fakeProvider({ maxBatch: 2 });
    const vectors = await fakeVectorStore(h);
    const index = createBrainSearchIndex({ db: h.db, meaning: { provider, vectors }, now: h.now });
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a", body: "x ".repeat(2_500) }, { seed: "b" }, { seed: "c" }]);
    provider.fail = true;
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 3, removed: 0, caughtUp: false, embedding: NONE });
    expect(provider.calls).toHaveLength(1);
    expect(error).toHaveBeenCalledWith("[brain-search] embeddings failed:", "Error");
    provider.fail = false;
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 3, removed: 0, caughtUp: true, embedding: NONE });
    expect(vectors.replaced.sort()).toEqual([`${brainDocumentId("a")}:3`, `${brainDocumentId("b")}:1`,
      `${brainDocumentId("c")}:1`].sort());

    await seeder.sync([{ seed: "a", body: "revised a" }]);
    const controller = new AbortController();
    provider.fail = () => { controller.abort(); throw new Error("aborted"); };
    expect(await index.refresh(SCOPE, {}, controller.signal)).toEqual({ processed: 1, removed: 0, caughtUp: false,
      embedding: NONE });
    vectors.replaceChunks = async () => { throw Object.assign(new Error("gone"), { code: "23503" }); };
    provider.fail = false;
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 1, removed: 0, caughtUp: false, embedding: NONE });
    vectors.replaceChunks = async () => { throw Object.assign(new Error("db down"), { code: "57P01" }); };
    await expect(index.refresh(SCOPE, {}, signal())).rejects.toThrow("db down");
  });

  it("skips documents that stopped being live or changed between selection and embedding", async () => {
    const provider = fakeProvider({ maxBatch: 1 });
    const index = createBrainSearchIndex({ db: h.db, meaning: { provider, vectors: await fakeVectorStore(h) }, now: h.now });
    const seeder = await createSeeder(h);
    const [first, second, third] = ["a", "b", "c"].sort((x, y) => (brainDocumentId(x) < brainDocumentId(y) ? -1 : 1));
    await seeder.sync([{ seed: first! }, { seed: second! }, { seed: third! }]);
    provider.fail = async (texts) => {
      provider.fail = false;
      await seeder.sync([{ seed: third!, body: "revised" }], [second!]);
      return texts.map((text) => fakeVector(text));
    };
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 3, removed: 0, caughtUp: false, embedding: NONE });
    expect(provider.calls).toHaveLength(1);
  });

  it("builds text rows past a failing provider and retries a failed embedding after fresh ones", async () => {
    const provider = fakeProvider();
    const vectors = await fakeVectorStore(h);
    const index = createBrainSearchIndex({ db: h.db, meaning: { provider, vectors }, now: h.now });
    const seeder = await createSeeder(h);
    const seeds = ["a", "b", "c", "d"].sort((x, y) => (brainDocumentId(x) < brainDocumentId(y) ? -1 : 1));
    await seeder.sync(seeds.map((seed, at) => ({ seed, body: at === 0 ? "poison" : `body ${seed}` })));
    provider.fail = true;
    for (const limits of [{ documents: 2 }, { documents: 2 }]) {
      expect(await index.refresh(SCOPE, limits, signal())).toMatchObject({ processed: 2 });
    }
    expect(await rows(h, "brain_search_documents")).toBe(4);
    provider.fail = (texts) => {
      if (texts.some((text) => text.includes("poison"))) throw "poison";
      return texts.map((text) => fakeVector(text));
    };
    for (const limits of [{}, {}]) await index.refresh(SCOPE, limits, signal());
    expect(vectors.replaced.sort()).toEqual(seeds.slice(1).map((seed) => `${brainDocumentId(seed)}:1`).sort());
    expect(await index.freshness(SCOPE)).toMatchObject({ pendingDocuments: 1 });
    expect(error).toHaveBeenCalledWith("[brain-search] embeddings failed:", "UnknownError");
  });

  it("checks the time budget before each provider call", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const provider = fakeProvider({ maxBatch: 1 });
    provider.fail = (texts) => {
      clock += 30_000;
      return texts.map((text) => fakeVector(text));
    };
    const index = createBrainSearchIndex({ db: h.db, meaning: { provider, vectors: await fakeVectorStore(h) }, now: h.now });
    await (await createSeeder(h)).sync([{ seed: "a" }, { seed: "b" }, { seed: "c" }]);
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 3, removed: 0, caughtUp: false, embedding: NONE });
    expect(provider.calls).toHaveLength(1);
  });

  it("does not embed a document that was tombstoned after its rebuild", async () => {
    const provider = fakeProvider();
    const index = createBrainSearchIndex({ db: h.db, meaning: { provider, vectors: await fakeVectorStore(h) }, now: h.now });
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a" }]);
    await sql.raw(`CREATE FUNCTION test_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE brain_documents SET deleted_at = now(), title = '', body = '', permalink = '', byte_count = 0
        WHERE document_id = NEW.document_id; RETURN NEW; END $$`).execute(h.db);
    await sql.raw(`CREATE TRIGGER test_tombstone AFTER INSERT ON brain_search_documents
      FOR EACH ROW EXECUTE FUNCTION test_tombstone()`).execute(h.db);
    expect(await index.refresh(SCOPE, {}, signal())).toEqual({ processed: 1, removed: 0, caughtUp: false, embedding: NONE });
    expect(provider.calls).toEqual([]);
  });
});
