/**
 * Meaning search with a fake embeddings provider and a fake vector store over a plain table, fused with full text by
 * reciprocal rank; fallbacks, errors, capability, the candidate cap and the refresh cap every entry point shares.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type {
  BrainSearchCapabilityView, BrainSearchQuery, BrainVectorStore,
} from "../../packages/gateway/src/brain/contracts.js";
import { createBrainSearch } from "../../packages/gateway/src/brain/search/index.js";
import { brainDocumentId } from "./helpers/brain-store-helpers.js";
import {
  OWNER, PROJECT_ID, SCOPE, createSearchHarness, createSeeder, fakeProvider, fakeVector, fakeVectorStore, resolver,
  seedClaims, type FakeProvider, type SearchHarness,
} from "./helpers/brain-search-fakes.js";

/** What the bootstrap reports where pgvector exists. */
const EXTENSION: BrainSearchCapabilityView = { fullText: true, vector: "provider_not_configured", providerId: null };

describe("brain search hybrid", { timeout: 60_000 }, () => {
  let h: SearchHarness;
  let provider: FakeProvider;
  let vectors: BrainVectorStore;
  let error: MockInstance<typeof console.error>;
  let warn: MockInstance<typeof console.warn>;
  let seeder: Awaited<ReturnType<typeof createSeeder>>;
  const feature = (extra: { vectors?: BrainVectorStore | null; capability?: BrainSearchCapabilityView } = {}) =>
    createBrainSearch({ repository: h.repository, resolver, capability: extra.capability ?? h.capability, embeddings: provider,
      vectors: extra.vectors === undefined ? vectors : extra.vectors, now: h.now });
  const search = (query: BrainSearchQuery, extra = {}) => feature(extra).service.search(OWNER, PROJECT_ID, query);

  beforeEach(async () => {
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h = await createSearchHarness();
    provider = fakeProvider();
    vectors = await fakeVectorStore(h);
    seeder = await createSeeder(h);
    await seeder.sync([
      { seed: "ledger", title: "Ledger design", body: `${"padding words here. ".repeat(120)}money ledger balance totals` },
      { seed: "alpha", title: "Alpha notes", body: "alpha keeps the money ledger in one place" },
      { seed: "other", title: "Unrelated", body: "kittens and gardens" },
    ]);
    await feature().service.refresh(OWNER, PROJECT_ID);
  });
  afterEach(async () => { error.mockRestore(); warn.mockRestore(); await h.destroy(); });

  it("reports the capability and fuses text and vector hits in auto mode", async () => {
    expect(feature().service.capability()).toEqual({ fullText: true, vector: "available", providerId: "fake-embed",
      store: "array" });
    const view = await search({ q: "money ledger" });
    expect(view.mode).toBe("hybrid");
    expect(view.items[0]).toMatchObject({ matchedBy: ["text", "vector"] });
    expect(view.items[0]!.score).toBeGreaterThan(0.9);
    const vectorOnly = await search({ q: "gardens kittens unrelated", mode: "hybrid", types: ["document"] });
    expect(vectorOnly.items.some((item) => item.matchedBy.length === 1 && item.matchedBy[0] === "vector")).toBe(true);
    const ledger = (await search({ q: "balance", mode: "hybrid" })).items.find((item) => item.hitId === brainDocumentId("ledger"))!;
    expect(ledger.snippet.highlights.length).toBeGreaterThan(0);
  });

  it("gives meaning search only to the owner whose key the provider holds; others search by text alone", async () => {
    const owned = (ownerIds: readonly string[]) => createBrainSearch({ repository: h.repository, resolver,
      capability: h.capability, embeddings: provider, vectors, now: h.now, embeddingOwnerIds: ownerIds });
    const calls = provider.calls.length;
    const other = owned(["owner_elsewhere"]).service;
    const view = await other.search(OWNER, PROJECT_ID, { q: "money ledger" });
    expect(view).toMatchObject({ mode: "text", capability: { vector: "provider_not_configured", providerId: null } });
    await expect(other.search(OWNER, PROJECT_ID, { q: "money ledger", mode: "hybrid" }))
      .rejects.toMatchObject({ code: "vector_search_unavailable" });
    // A refresh of a scope the provider does not serve sends nothing and reports no embedding spend.
    await seeder.sync([{ seed: "fresh", title: "Fresh", body: "a new money ledger note" }]);
    const refreshed = await other.refresh(OWNER, PROJECT_ID);
    expect(refreshed).toMatchObject({ caughtUp: true, freshness: { caughtUp: true } });
    expect(refreshed.embedding).toBeUndefined();
    expect(provider.calls.length).toBe(calls);
    // The owner still gets it.
    expect((await owned([OWNER]).service.search(OWNER, PROJECT_ID, { q: "money ledger" })).mode).toBe("hybrid");
    expect(provider.calls.length).toBeGreaterThan(calls);
  });

  it("snippets vector-only hits from their best chunk and pages within the fused window", async () => {
    const view = await search({ q: "padding totals xyz", types: ["document"], kinds: ["document"] });
    const ledger = view.items.find((item) => item.hitId === brainDocumentId("ledger"))!;
    expect(ledger.matchedBy).toContain("vector");
    const all = (await search({ q: "money ledger" })).items.map((item) => item.hitId);
    const first = await search({ q: "money ledger", limit: 1 });
    const second = await search({ q: "money ledger", limit: 1, cursor: first.nextCursor! });
    expect([...first.items, ...second.items].map((item) => item.hitId)).toEqual(all.slice(0, 2));
    await expect(search({ q: "money ledger", mode: "text", cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: "invalid_request" });
    const empty: BrainVectorStore = { replaceChunks: vectors.replaceChunks, nearest: async () => [] };
    expect((await search({ q: "money ledger" }, { vectors: empty })).items.every((item) => item.matchedBy[0] === "text"))
      .toBe(true);
  });

  it("drops a meaning match whose document changed after its vectors were read", async () => {
    // A sync lands between the vector read and the search snapshot.
    const changing: BrainVectorStore = { replaceChunks: vectors.replaceChunks, async nearest(scope, vector, limit, id) {
      const matches = await vectors.nearest(scope, vector, limit, id);
      await seeder.sync([{ seed: "other", title: "Unrelated", body: "now about something else" }]);
      return matches;
    } };
    const view = await search({ q: "zebra", mode: "hybrid", types: ["document"] }, { vectors: changing });
    expect(view.items.map((item) => [item.hitId, item.matchedBy]).sort()).toEqual([
      [brainDocumentId("alpha"), ["vector"]], [brainDocumentId("ledger"), ["vector"]]].sort());
    expect(view.items.map((item) => item.snippet.text).join(" ")).not.toContain("something else");
  });

  it("falls back to text in auto mode on a provider failure, keeps each cursor's mode, lets store errors through", async () => {
    const hybrid = await search({ q: "money ledger", limit: 1 });
    provider.fail = true;
    const first = await search({ q: "money ledger", limit: 1 });
    expect([first.mode, first.nextCursor === null]).toEqual(["text", false]);
    expect(error).toHaveBeenCalledWith("[brain-search] meaning search failed:", "Error");
    provider.fail = () => { throw "down"; };
    expect((await search({ q: "money ledger" })).mode).toBe("text");
    expect(error).toHaveBeenCalledWith("[brain-search] meaning search failed:", "UnknownError");
    await expect(search({ q: "money", mode: "hybrid" })).rejects.toMatchObject({ code: "vector_search_unavailable" });
    await expect(search({ q: "money ledger", limit: 1, cursor: hybrid.nextCursor! }))
      .rejects.toMatchObject({ code: "vector_search_unavailable" });
    provider.fail = false;
    const second = await search({ q: "money ledger", limit: 1, cursor: first.nextCursor! });
    expect(second.mode).toBe("text");
    expect(second.items.map((item) => item.hitId)).not.toEqual(first.items.map((item) => item.hitId));
    await expect(search({ q: "money ledger", limit: 1, cursor: hybrid.nextCursor! }, { vectors: null }))
      .rejects.toMatchObject({ code: "vector_search_unavailable" });
    const broken: BrainVectorStore = { replaceChunks: vectors.replaceChunks,
      nearest: async () => { throw Object.assign(new Error("db down"), { code: "57P01" }); } };
    await expect(search({ q: "money ledger" }, { vectors: broken })).rejects.toThrow("db down");
  });

  it("is on with or without the extension, and off without a vector store or with an unusable provider", async () => {
    expect(feature({ capability: EXTENSION }).service.capability()).toMatchObject({ store: "pgvector" });
    expect(feature({ vectors: null }).service.capability())
      .toEqual({ fullText: true, vector: "extension_missing", providerId: "fake-embed" });
    expect(feature({ vectors: null, capability: EXTENSION }).service.capability().vector).toBe("provider_not_configured");
    provider = fakeProvider({ dimensions: 0 });
    expect(feature({ capability: EXTENSION }).service.capability())
      .toEqual({ fullText: true, vector: "provider_not_configured", providerId: null });
    expect(error).toHaveBeenCalledWith("[brain-search] embeddings provider settings are invalid");
    expect((await search({ q: "money" })).mode).toBe("text");
  });

  it("reports candidates_capped when a retriever fills its window and pages at most 200 fused hits", async () => {
    const { documentId, incarnation, revision } = (await h.repository.getDocument(SCOPE, brainDocumentId("other")))!;
    const stub: BrainVectorStore = { replaceChunks: vectors.replaceChunks, nearest: async () =>
      Array.from({ length: 200 }, (_, index) => ({ documentId, incarnation, revision, chunkIndex: index % 40, distance: 0.1 })) };
    expect((await search({ q: "kittens" }, { vectors: stub })).notices).toEqual(["candidates_capped"]);
    const statements = Array.from({ length: 50 }, (_, index) => `money rule ${index}`);
    const seeds = ["x1", "x2", "x3", "x4", "x5"];
    await seeder.sync(seeds.map((seed) => ({ seed, body: statements.join("\n") })));
    for (const seed of seeds) await seedClaims(h, seed, statements.map((statement) => ({ kind: "commitment", statement, quote: statement })));
    await feature().service.refresh(OWNER, PROJECT_ID);
    let page = await search({ q: "money rule", limit: 50 });
    expect(page.notices).toEqual(["candidates_capped"]);
    for (let pages = 1; pages < 4; pages += 1) page = await search({ q: "money rule", limit: 50, cursor: page.nextCursor! });
    expect(page.nextCursor).toBeNull();
  });

  it("shares one refresh cap between the route and the index it returns, never refusing a scope erase", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let waiting = 0;
    provider.fail = async (texts) => {
      waiting += 1;
      await gate;
      return texts.map((text) => fakeVector(text, provider.dimensions));
    };
    await seeder.sync([{ seed: "fresh", title: "Fresh", body: "a new money ledger note" }]);
    const { service, index } = feature();
    const signal = () => AbortSignal.timeout(30_000);
    const running = [service.refresh(OWNER, PROJECT_ID), index.refresh(SCOPE, {}, signal())];
    await vi.waitFor(() => expect(waiting).toBe(2), { timeout: 10_000 });
    const changed = { type: "documents_changed", scope: SCOPE, sourceId: null, documentIds: null, at: h.iso() } as const;
    for (const refused of [() => service.refresh(OWNER, PROJECT_ID), () => index.refresh(SCOPE, {}, signal()),
      () => index.handle(changed, signal())]) await expect(refused()).rejects.toMatchObject({ code: "brain_unavailable" });
    const elsewhere = { ownerId: "owner_b", scopeId: SCOPE.scopeId };
    await expect(index.handle({ type: "scope_erased", scope: elsewhere, at: h.iso() }, signal())).resolves.toBeUndefined();
    release();
    expect(await Promise.all(running)).toMatchObject([{ caughtUp: true }, { caughtUp: true }]);
    await expect(index.handle(changed, signal())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[brain] search refresh refused: 2 already running");
  });
});
