/**
 * The array vector store (stock Postgres, no pgvector): unit vectors under a strict CHECK, nearest neighbours equal to
 * a brute-force scan, the per-scope cap, writes skipped for documents no longer at the input's revision, vectors
 * read back by text key, the default-store switch and cleanup. PGlite always; a disposable real PostgreSQL schema too
 * when MATRIX_TEST_POSTGRES_URL is set.
 */
import { randomUUID } from "node:crypto";
import { PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainVectorStore } from "../../packages/gateway/src/brain/contracts.js";
import { BrainRepository, BrainStoreError } from "../../packages/gateway/src/brain/index.js";
import { brainUnitVector } from "../../packages/gateway/src/brain/search/array-store.js";
import {
  bootstrapBrainSearchDatabase, createBrainArrayVectorStore, createBrainSearch,
} from "../../packages/gateway/src/brain/search/index.js";
import { BrainSearchVectorCapError, type BrainSearchVectorStore } from "../../packages/gateway/src/brain/search/types.js";
import { BRAIN_CLOCK_START, brainDocumentId } from "./helpers/brain-store-helpers.js";
import {
  OWNER, PROJECT_ID, SCOPE, createSearchHarness, createSeeder, fakeProvider, resolver, type SearchHarness,
} from "./helpers/brain-search-fakes.js";

/** Seeded uniform numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const randomVector = (rand: () => number, dims: number) => Array.from({ length: dims }, () => rand() * 2 - 1);
const vectorRows = async (h: SearchHarness, documentId?: string) => Number((await sql<{ n: number }>`
  SELECT count(*)::int AS n FROM brain_search_vectors WHERE owner_id = ${SCOPE.ownerId}
    ${documentId === undefined ? sql`` : sql`AND document_id = ${documentId}`}`.execute(h.db)).rows[0]!.n);

async function documentOf(h: SearchHarness, seed: string) {
  return (await h.repository.getDocument(SCOPE, brainDocumentId(seed)))!;
}

/** The document's (incarnation, revision), tombstoned or not. */
async function stateOf(h: SearchHarness, seed: string) {
  const rows = await sql<{ incarnation: string; revision: number }>`SELECT incarnation, revision FROM brain_documents
    WHERE owner_id = ${SCOPE.ownerId} AND scope_id = ${SCOPE.scopeId} AND document_id = ${brainDocumentId(seed)}`
    .execute(h.db);
  return { documentId: brainDocumentId(seed), ...rows.rows[0]! };
}

async function replace(h: SearchHarness, store: BrainVectorStore, seed: string, vectors: number[][], providerId = "p") {
  const document = await documentOf(h, seed);
  await store.replaceChunks(SCOPE, { documentId: document.documentId, incarnation: document.incarnation,
    revision: document.revision, providerId,
    chunks: vectors.map((vector, index) => ({ spanStart: index, spanEnd: index + 1, vector })) });
}

/** Seeds documents x chunks random vectors and checks nearest against a brute-force scan of the stored values. */
async function expectExactNearest(h: SearchHarness, documents: number, chunks: number, dims: number): Promise<void> {
  const store = createBrainArrayVectorStore(h.db);
  const rand = mulberry32(dims);
  const seeds = Array.from({ length: documents }, (_, index) => `doc${index}`);
  await (await createSeeder(h)).sync(seeds.map((seed) => ({ seed })));
  const stored: { documentId: string; incarnation: string; revision: number; chunkIndex: number; unit: number[] }[] = [];
  for (const seed of seeds) {
    const vectors = Array.from({ length: chunks }, () => randomVector(rand, dims));
    await replace(h, store, seed, vectors);
    const { documentId, incarnation, revision } = await documentOf(h, seed);
    vectors.forEach((vector, chunkIndex) =>
      stored.push({ documentId, incarnation, revision, chunkIndex, unit: brainUnitVector(vector)! }));
  }
  for (let round = 0; round < 3; round += 1) {
    const query = randomVector(rand, dims);
    const unit = brainUnitVector(query)!;
    const expected = stored.map((row) => {
      let dot = 0;
      for (let index = 0; index < dims; index += 1) dot += row.unit[index]! * unit[index]!;
      return { documentId: row.documentId, incarnation: row.incarnation, revision: row.revision,
        chunkIndex: row.chunkIndex, distance: 1 - dot };
    }).sort((a, b) => a.distance - b.distance || (a.documentId === b.documentId ? a.chunkIndex - b.chunkIndex
      : a.documentId < b.documentId ? -1 : 1)).slice(0, 200);
    expect(await store.nearest(SCOPE, query, 200, "p")).toEqual(expected);
  }
}

describe("brain search array store", { timeout: 60_000 }, () => {
  let h: SearchHarness;
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h = await createSearchHarness();
  });
  afterEach(async () => { vi.restoreAllMocks(); await h.destroy(); });

  it("stores unit float4 vectors under a strict CHECK and replaces a document's vectors", async () => {
    const store = createBrainArrayVectorStore(h.db);
    await (await createSeeder(h)).sync([{ seed: "a" }]);
    await replace(h, store, "a", [[3, 4, 0], [0, 0, 0], [0, 0, -2], [1, 1e-45, 0]]);
    const rows = await sql<{ chunk_index: number; dimensions: number; embedding: number[] }>`SELECT chunk_index,
      dimensions, embedding::float8[] AS embedding FROM brain_search_vectors ORDER BY chunk_index`.execute(h.db);
    expect(rows.rows).toEqual([{ chunk_index: 0, dimensions: 3, embedding: [Math.fround(0.6), Math.fround(0.8), 0] },
      { chunk_index: 2, dimensions: 3, embedding: [0, 0, -1] }, { chunk_index: 3, dimensions: 3, embedding: [1, 0, 0] }]);
    await replace(h, store, "a", [[0, 1, 0]]);
    expect(await vectorRows(h)).toBe(1);
    await replace(h, store, "a", []);
    expect(await vectorRows(h)).toBe(0);
    const document = await documentOf(h, "a");
    const insert = (embedding: string) => sql`INSERT INTO brain_search_vectors (owner_id, scope_id, document_id,
      chunk_index, incarnation, revision, provider_id, dimensions, embedding) VALUES (${SCOPE.ownerId},
      ${SCOPE.scopeId}, ${document.documentId}, 0, ${document.incarnation}, ${document.revision}, 'p', 3,
      ${embedding}::real[])`.execute(h.db);
    for (const bad of ["{1,0}", "{NaN,0,0}", "{Infinity,0,0}", "{{1,0,0}}", "{1,NULL,0}", "{1.5,0,0}", "{-1.5,0,0}"]) {
      await expect(insert(bad)).rejects.toMatchObject({ code: "23514" });
    }
    // A table made before text keys gets the column at the next start.
    await sql`ALTER TABLE brain_search_vectors DROP COLUMN text_key`.execute(h.db);
    await bootstrapBrainSearchDatabase(h.db);
    await replace(h, store, "a", [[0, 1, 0]]);
    expect(await vectorRows(h)).toBe(1);
    for (const bad of [() => replace(h, store, "a", [[Number.NaN]]), () => replace(h, store, "a", [[1]], "Bad Id"),
      () => store.nearest(SCOPE, [1], 0, "p"), () => store.nearest({ ownerId: "", scopeId: "x" }, [1], 1, "p"),
      () => store.remaining!({ ownerId: "", scopeId: "x" })]) await expect(bad()).rejects.toBeInstanceOf(BrainStoreError);
  });

  it("finds the same nearest chunks as a brute-force scan, best first", async () => {
    await expectExactNearest(h, 40, 25, 64);
  });

  it("returns only live documents at their indexed revision, of the asked provider, size and scope", async () => {
    const store = createBrainArrayVectorStore(h.db);
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a" }, { seed: "b" }, { seed: "c" }, { seed: "d" }]);
    await replace(h, store, "a", [[1, 0, 0]]);
    await replace(h, store, "b", [[0.9, 0.1, 0]]);
    await replace(h, store, "c", [[1, 0, 0]], "other");
    await replace(h, store, "d", [[1, 0]]);
    expect((await store.nearest(SCOPE, [2, 0, 0], 5, "p")).map((match) => [match.documentId, match.distance]))
      .toEqual([[brainDocumentId("a"), 0], [brainDocumentId("b"), 1 - Math.fround(0.9 / Math.hypot(0.9, 0.1))]]);
    expect(await store.nearest(SCOPE, [0, 0, 0], 5, "p")).toEqual([]);
    expect(await store.nearest({ ...SCOPE, ownerId: "owner_b" }, [1, 0, 0], 5, "p")).toEqual([]);
    await seeder.sync([{ seed: "a", body: "revised" }], ["b"]);
    expect(await store.nearest(SCOPE, [1, 0, 0], 5, "p")).toEqual([]);
  });

  it("counts room per scope and refuses a write past the cap, keeping the old vectors", async () => {
    const store = createBrainArrayVectorStore(h.db, { maxPerScope: 3 });
    await (await createSeeder(h)).sync([{ seed: "a" }, { seed: "b" }]);
    await replace(h, store, "a", [[1, 0], [0, 1]]);
    expect(await store.remaining!(SCOPE)).toBe(1);
    await expect(replace(h, store, "b", [[1, 0], [0, 1]])).rejects.toBeInstanceOf(BrainSearchVectorCapError);
    expect([await vectorRows(h, brainDocumentId("a")), await vectorRows(h, brainDocumentId("b"))]).toEqual([2, 0]);
    await replace(h, store, "a", [[1, 0], [0, 1], [1, 1]]);
    expect([await store.remaining!(SCOPE), await store.remaining!({ ...SCOPE, ownerId: "owner_b" })]).toEqual([0, 3]);
    // Rows of the documents about to be replaced do not count.
    expect(await store.remaining!(SCOPE, [brainDocumentId("a"), brainDocumentId("b")])).toBe(3);
    await expect(store.remaining!(SCOPE, ["junk"])).rejects.toBeInstanceOf(BrainStoreError);
  });

  it("skips a write for a document no longer live at the input's revision and reads vectors back by text key", async () => {
    const store = createBrainArrayVectorStore(h.db);
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a" }, { seed: "b" }]);
    const [older, gone] = [await documentOf(h, "a"), await documentOf(h, "b")];
    await seeder.sync([{ seed: "a", body: "revised" }], ["b"]);
    const key = "0".repeat(32);
    await replace(h, store, "a", [[1, 0]]);
    const write = (document: typeof older, vector: number[], textKey?: string) => store.replaceChunks(SCOPE, {
      documentId: document.documentId, incarnation: document.incarnation, revision: document.revision,
      providerId: "p", chunks: [{ spanStart: 0, spanEnd: 1, vector, ...(textKey === undefined ? {} : { textKey }) }] });
    await write(older, [0, 1]);
    await write(gone, [0, 1]);
    const rows = await sql<{ document_id: string; revision: number }>`SELECT document_id, revision
      FROM brain_search_vectors`.execute(h.db);
    expect(rows.rows).toEqual([{ document_id: brainDocumentId("a"), revision: 2 }]);
    await write(await documentOf(h, "a"), [3, 4], key);
    const ask = { providerId: "p", dimensions: 2, documentIds: [brainDocumentId("a")], textKeys: [key, "f".repeat(32)] };
    expect(await store.storedVectors!(SCOPE, ask)).toEqual(new Map([[key, [Math.fround(0.6), Math.fround(0.8)]]]));
    for (const other of [{ providerId: "q" }, { dimensions: 3 }, { documentIds: [] }]) {
      expect((await store.storedVectors!(SCOPE, { ...ask, ...other })).size).toBe(0);
    }
    await expect(store.storedVectors!(SCOPE, { ...ask, textKeys: ["xyz"] })).rejects.toBeInstanceOf(BrainStoreError);
    await expect(write(await documentOf(h, "a"), [1, 0], "XYZ")).rejects.toBeInstanceOf(BrainStoreError);
  });

  it("skips a removal while the document is live at another revision, so a late sweep keeps restored vectors", async () => {
    const store = createBrainArrayVectorStore(h.db);
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a" }]);
    await seeder.sync([], ["a"]);
    const tombstone = await stateOf(h, "a");
    await seeder.sync([{ seed: "a", body: "restored" }]);
    await replace(h, store, "a", [[1, 0]]);
    const remove = () => store.replaceChunks(SCOPE, { ...tombstone, providerId: "p", chunks: [] });
    await remove();
    expect(await vectorRows(h)).toBe(1);
    // Tombstoned again, the document holds no vectors worth keeping: the late removal goes ahead.
    await seeder.sync([], ["a"]);
    await remove();
    expect(await vectorRows(h)).toBe(0);
  });

  it("keeps a document restored and embedded while a refresh sweeps its old tombstone", async () => {
    const provider = fakeProvider();
    const store = createBrainArrayVectorStore(h.db);
    const feature = (vectors: BrainSearchVectorStore) => createBrainSearch({ repository: h.repository, resolver,
      capability: h.capability, embeddings: provider, vectors, now: h.now });
    let restore: (() => Promise<void>) | null = null;
    // The sweep's removal waits on the restore, as if the sync and another refresh ran between its read and write.
    const late: BrainSearchVectorStore = { ...store, async replaceChunks(scope, input) {
      const run = input.chunks.length === 0 ? restore : null;
      restore = null;
      await run?.();
      return store.replaceChunks(scope, input);
    } };
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a", body: "kittens" }]);
    await feature(store).service.refresh(OWNER, PROJECT_ID);
    await seeder.sync([], ["a"]);
    restore = async () => {
      await seeder.sync([{ seed: "a", body: "kittens again" }]);
      expect(await feature(store).index.refresh(SCOPE, {}, AbortSignal.timeout(30_000)))
        .toMatchObject({ processed: 1, caughtUp: true });
    };
    expect(await feature(late).service.refresh(OWNER, PROJECT_ID)).toMatchObject({ removed: 0, caughtUp: true });
    expect(restore).toBeNull();
    expect(await vectorRows(h, brainDocumentId("a"))).toBe(1);
    const view = await feature(store).service.search(OWNER, PROJECT_ID, { q: "kittens", mode: "hybrid" });
    expect(view.items.map((item) => [item.hitId, item.matchedBy])).toEqual([[brainDocumentId("a"), ["text", "vector"]]]);
  });

  it("is the default store without pgvector and loses tombstoned and erased documents' vectors", async () => {
    const feature = createBrainSearch({ repository: h.repository, resolver, capability: h.capability,
      embeddings: fakeProvider(), now: h.now });
    expect(feature.service.capability()).toEqual({ fullText: true, vector: "available", providerId: "fake-embed",
      store: "array" });
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a", body: "kittens and gardens" }, { seed: "b", body: "kittens ledger" },
      { seed: "c", body: "gardens" }]);
    await feature.service.refresh(OWNER, PROJECT_ID);
    expect(await vectorRows(h)).toBe(3);
    const view = await feature.service.search(OWNER, PROJECT_ID, { q: "kittens", mode: "hybrid" });
    expect(view.items.map((item) => item.matchedBy)).toContainEqual(["text", "vector"]);
    await seeder.sync([], ["a"]);
    expect(await feature.service.refresh(OWNER, PROJECT_ID)).toMatchObject({ removed: 1 });
    expect(await vectorRows(h, brainDocumentId("a"))).toBe(0);
    // Without a provider the sweep still drops a tombstoned document's vectors.
    const textOnly = createBrainSearch({ repository: h.repository, resolver, capability: h.capability, now: h.now });
    await seeder.sync([], ["b"]);
    expect(await textOnly.service.refresh(OWNER, PROJECT_ID)).toMatchObject({ removed: 1 });
    expect([await vectorRows(h, brainDocumentId("b")), await vectorRows(h)]).toEqual([0, 1]);
    await h.repository.eraseScope(SCOPE);
    expect(await vectorRows(h)).toBe(0);
  });
});

// PGlite is not the server customers run: the same checks on a disposable PostgreSQL schema.
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)("brain search array store on PostgreSQL", { timeout: 120_000 }, () => {
  let admin: pg.Pool;
  let schema: string;
  let h: SearchHarness;
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    schema = `brain_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const clock = new Date(BRAIN_CLOCK_START);
    const repository = new BrainRepository(new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString(), max: 2 }) }), { now: () => clock });
    await repository.bootstrap();
    const harness = { repository, db: repository.kysely, now: () => clock, iso: () => clock.toISOString(),
      tick: () => undefined, destroy: () => repository.destroy() };
    h = { ...harness, capability: await bootstrapBrainSearchDatabase(harness.db) };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.destroy();
    if (schema && admin) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it("finds the same nearest chunks as a brute-force scan at the provider's size", async () => {
    await expectExactNearest(h, 80, 25, 256);
    const document = await documentOf(h, "doc0");
    await expect(sql`INSERT INTO brain_search_vectors (owner_id, scope_id, document_id, chunk_index, incarnation,
      revision, provider_id, dimensions, embedding) VALUES (${SCOPE.ownerId}, ${SCOPE.scopeId}, ${document.documentId},
      39, ${document.incarnation}, ${document.revision}, 'p', 1, '{NaN}'::real[])`.execute(h.db))
      .rejects.toMatchObject({ code: "23514" });
    const store = createBrainArrayVectorStore(h.db);
    const key = "1".repeat(32);
    await store.replaceChunks(SCOPE, { documentId: document.documentId, incarnation: document.incarnation,
      revision: document.revision, providerId: "p", chunks: [{ spanStart: 0, spanEnd: 1, vector: [3, 4], textKey: key }] });
    expect(await store.storedVectors!(SCOPE, { providerId: "p", dimensions: 2, documentIds: [document.documentId],
      textKeys: [key] })).toEqual(new Map([[key, [Math.fround(0.6), Math.fround(0.8)]]]));
    expect(await store.remaining!(SCOPE, [document.documentId])).toBe(50_000 - 79 * 25);
  });
});
