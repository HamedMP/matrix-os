/**
 * Hybrid search with the OpenAI provider (fake fetch) over the array store: refreshes embed several documents per
 * call (claim statements too), send only chunks whose text changed, and record tokens and cost; the per-refresh
 * budget, a missing or refused key, outages, refused inputs and a full store each stop the pass as specified; a
 * revised document is embedded again in a full store, and a slow pass never overwrites a newer revision's vectors.
 * Every paid pass and query is logged by counts only. Without a key nothing changes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { BrainVectorStore } from "../../packages/gateway/src/brain/contracts.js";
import {
  createBrainArrayVectorStore, createBrainSearch, createBrainSearchEmbeddings,
} from "../../packages/gateway/src/brain/search/index.js";
import { createBrainOpenAiEmbeddings } from "../../packages/gateway/src/brain/search/openai.js";
import { BrainSearchVectorCapError } from "../../packages/gateway/src/brain/search/types.js";
import { brainDocumentId } from "./helpers/brain-store-helpers.js";
import {
  EVERY_PROVENANCE, OWNER, PROJECT_ID, SCOPE, createSearchHarness, createSeeder, resolver, seedClaims,
  type SearchHarness,
} from "./helpers/brain-search-fakes.js";
import { createOpenAiFetch, fakeTokens, openAiError, openAiSuccess } from "./helpers/brain-search-openai-fetch.js";

const KEY = "sk-proj-test_0123456789abcdefABCDEF";
const PROVIDER = "openai/text-embedding-3-small/256";
const MARKER = `array:${PROVIDER}`;

describe("brain search embedding refresh", { timeout: 60_000 }, () => {
  let h: SearchHarness;
  let api: ReturnType<typeof createOpenAiFetch>;
  let key: string | null;
  let error: MockInstance<typeof console.error>;
  let seeder: Awaited<ReturnType<typeof createSeeder>>;
  // The fixtures' documents are "manual": the owner lists every provenance here (the default sends git ones only).
  const openai = (fetch = api.fetch) => ({ ...createBrainOpenAiEmbeddings({ dimensions: 256, apiKey: async () => key,
    fetch, wait: async () => undefined }), provenances: EVERY_PROVENANCE });
  const feature = (extra: { vectors?: BrainVectorStore; fetch?: typeof globalThis.fetch } = {}) => createBrainSearch({
    repository: h.repository, resolver, capability: h.capability, embeddings: openai(extra.fetch), now: h.now,
    ...(extra.vectors === undefined ? {} : { vectors: extra.vectors }) });
  const refresh = (extra: Parameters<typeof feature>[0] = {}) => feature(extra).service.refresh(OWNER, PROJECT_ID);
  const embedded = async () => (await sql<{ document_id: string; embedded_provider: string | null;
    failed: boolean }>`SELECT document_id, embedded_provider, embed_failed_at IS NOT NULL AS failed
    FROM brain_search_documents ORDER BY document_id`.execute(h.db)).rows;
  const ids = (...seeds: string[]) => seeds.map(brainDocumentId).sort();

  beforeEach(async () => {
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h = await createSearchHarness();
    api = createOpenAiFetch();
    key = KEY;
    seeder = await createSeeder(h);
  });
  afterEach(async () => { vi.restoreAllMocks(); await h.destroy(); });

  it("embeds several documents per call with their claim statements and records tokens and cost", async () => {
    await seeder.sync([{ seed: "garden", title: "Garden", body: "kittens and gardens" },
      { seed: "ledger", title: "Ledger", body: "money ledger balance" }, { seed: "rules", title: "Rules", body: "one lock" }]);
    await seedClaims(h, "rules", [{ kind: "invariant", statement: "Writers hold one lock per scope", quote: "one lock" }]);
    const first = await refresh();
    const inputs = api.calls.flatMap((call) => call.body.input);
    const tokens = inputs.reduce((sum, text) => sum + fakeTokens(text), 0);
    expect(first).toMatchObject({ processed: 3, caughtUp: true,
      embedding: { tokens, costMicroUsd: Math.ceil(tokens / 50), stopped: null } });
    expect([api.calls.length, inputs]).toEqual([1, expect.arrayContaining(["Rules\none lock",
      "Rules\nWriters hold one lock per scope"])]);
    expect((await embedded()).every((row) => row.embedded_provider === MARKER)).toBe(true);
    const search = feature().service;
    expect(search.capability()).toEqual({ fullText: true, vector: "available", providerId: PROVIDER, store: "array" });
    const view = await search.search(OWNER, PROJECT_ID, { q: "writers scope", mode: "hybrid", types: ["document"] });
    expect(view.items[0]).toMatchObject({ hitId: brainDocumentId("rules"), matchedBy: ["text", "vector"] });
    // New claims send only the claims chunk; the same statements from another run send nothing.
    await seedClaims(h, "rules", [{ kind: "risk", statement: "Long locks stall writers", quote: "one lock" }]);
    expect(await refresh()).toMatchObject({ processed: 1, caughtUp: true });
    expect(api.calls.at(-1)!.body.input).toEqual(["Rules\nLong locks stall writers"]);
    const sent = api.calls.length;
    await seedClaims(h, "rules", [{ kind: "risk", statement: "Long locks stall writers", quote: "one lock" }], "rules/v2");
    expect(await refresh()).toMatchObject({ processed: 1, caughtUp: true, embedding: { tokens: 0 } });
    expect(api.calls).toHaveLength(sent);
    const again = await search.search(OWNER, PROJECT_ID, { q: "stall writers", mode: "hybrid", types: ["document"] });
    expect(again.items[0]).toMatchObject({ hitId: brainDocumentId("rules"), matchedBy: ["text", "vector"] });
  });

  it("logs the spend of every paid pass and query by counts only, whichever path ran it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const spend = (call: unknown[]) => call[0] === "[brain-search] embedding spend";
    await seeder.sync([{ seed: "a", body: "kittens and gardens" }]);
    const search = feature();
    // The hook listener's pass: its result is dropped, so the log is the only trace of what it paid.
    await search.index.handle({ type: "documents_changed", scope: SCOPE, sourceId: null,
      documentIds: [brainDocumentId("a")], at: h.iso() }, AbortSignal.timeout(30_000));
    const tokens = fakeTokens("Title a\nkittens and gardens");
    expect(info.mock.calls.filter(spend)).toEqual([["[brain-search] embedding spend",
      { tokens, costMicroUsd: Math.ceil(tokens / 50), stopped: null }]]);
    // Nothing sent, nothing logged.
    expect(await search.service.refresh(OWNER, PROJECT_ID)).toMatchObject({ caughtUp: true, embedding: { tokens: 0 } });
    expect(info.mock.calls.filter(spend)).toHaveLength(1);
    // A pass that pays and then fails still logs what it paid.
    await seeder.sync([{ seed: "b", body: "ledger" }]);
    const broken: BrainVectorStore = { nearest: async () => [], replaceChunks: async () => {
      throw new Error("disk full"); } };
    await expect(refresh({ vectors: broken })).rejects.toThrow("disk full");
    const paid = fakeTokens("Title b\nledger");
    expect(info.mock.calls.filter(spend).at(-1)).toEqual(["[brain-search] embedding spend",
      { tokens: paid, costMicroUsd: Math.ceil(paid / 50), stopped: "error" }]);
    // Each hybrid search pays for its query embedding: logged with counts, never the query text.
    info.mockClear();
    await search.service.search(OWNER, PROJECT_ID, { q: "kittens", mode: "hybrid" });
    const query = fakeTokens("kittens");
    expect(info.mock.calls).toEqual([["[brain-search] query embedding spend",
      { tokens: query, costMicroUsd: Math.ceil(query / 50) }]]);
  });

  it("sends only the chunks of a revised body whose text changed", async () => {
    const part = (word: string) => `${word} `.repeat(300).trim();
    const body = [part("alpha"), part("beta"), part("gamma")].join("\n");
    await seeder.sync([{ seed: "long", title: "Long", body }]);
    await refresh();
    const first = api.calls[0]!.body.input;
    expect(first.length).toBeGreaterThan(2);
    await seeder.sync([{ seed: "long", title: "Long", body: `${body}\n${part("delta")}` }]);
    expect(await refresh()).toMatchObject({ processed: 1, caughtUp: true });
    const second = api.calls[1]!.body.input;
    expect(second.length).toBeLessThan(first.length);
    expect(second.every((text) => !first.includes(text))).toBe(true);
    const rows = await sql<{ revision: number }>`SELECT DISTINCT revision FROM brain_search_vectors`.execute(h.db);
    expect(rows.rows).toEqual([{ revision: 2 }]);
  });

  it("stops at the token or cost budget before the next call", async () => {
    const big = (seed: string) => ({ seed, body: `${seed} ${"word ".repeat(7_000)}` });
    await seeder.sync([big("a"), big("b"), big("c")]);
    for (const tokens of [999_999, 1_000_000]) {
      api.queue.push((call) => openAiSuccess(call.body.input, 256, { tokens }));
      const result = await refresh();
      expect(result).toMatchObject({ caughtUp: false, embedding: { tokens, costMicroUsd: 20_000, stopped: "budget" } });
      // A spent budget is progress: the next refresh goes on, so it is no stop reason.
      expect(result).not.toHaveProperty("stopReason");
    }
    expect(await refresh()).toMatchObject({ caughtUp: true, embedding: { stopped: null } });
    expect(api.calls.map((call) => call.body.input.length)).toEqual([20, 20, 20]);
  });

  it("ends the pass and records nothing when the key is gone or refused, or OpenAI is down", async () => {
    await seeder.sync([{ seed: "a" }, { seed: "b" }]);
    key = null;
    expect(await refresh()).toMatchObject({ caughtUp: false, stopReason: "embedding_unavailable",
      embedding: { tokens: 0, stopped: null } });
    expect(error).toHaveBeenLastCalledWith("[brain-search] embeddings failed:", "not_configured");
    key = KEY;
    api.queue.push(openAiError(401, "invalid_api_key"));
    expect(await refresh()).toMatchObject({ caughtUp: false, stopReason: "embedding_unavailable" });
    expect(error).toHaveBeenLastCalledWith("[brain-search] embeddings failed:", "auth_failed 401 invalid_api_key");
    api.queue.push(openAiError(503, null), openAiError(503, null), openAiError(503, null));
    expect(await refresh()).toMatchObject({ caughtUp: false });
    expect(error).toHaveBeenLastCalledWith("[brain-search] embeddings failed:", "unavailable 503");
    expect((await embedded()).map((row) => [row.embedded_provider, row.failed])).toEqual([[null, false], [null, false]]);
    const done = await refresh();
    expect(done).toMatchObject({ caughtUp: true });
    expect(done).not.toHaveProperty("stopReason");
  });

  it("retries a refused group one document at a time and records only the refused document", async () => {
    await seeder.sync([{ seed: "a" }, { seed: "b", body: "poison" }, { seed: "c" }]);
    const fetch: typeof globalThis.fetch = async (input, init) => (String(init?.body).includes("poison")
      ? openAiError(400, null) : api.fetch(input, init));
    expect(await refresh({ fetch })).toMatchObject({ caughtUp: false, embedding: { stopped: null } });
    expect(await refresh({ fetch })).toMatchObject({ caughtUp: false });
    const rows = await embedded();
    expect(rows.filter((row) => row.embedded_provider === MARKER).map((row) => row.document_id)).toEqual(ids("a", "c"));
    expect(rows.filter((row) => row.failed).map((row) => row.document_id)).toEqual(ids("b"));
    expect(error).toHaveBeenCalledWith("[brain-search] embeddings failed:", "invalid 400");
  });

  it("stops before paying when the vector store is full, and when a write finds it full", async () => {
    const store = createBrainArrayVectorStore(h.db, { maxPerScope: 2 });
    await seeder.sync([{ seed: "a" }, { seed: "b" }]);
    expect(await refresh({ vectors: store })).toMatchObject({ caughtUp: true });
    await seeder.sync([{ seed: "c" }]);
    expect(await refresh({ vectors: store }))
      .toMatchObject({ caughtUp: false, stopReason: "vector_cap", embedding: { stopped: "vector_cap" } });
    expect(api.calls).toHaveLength(1);
    const blind: BrainVectorStore = { nearest: store.nearest, replaceChunks: async () => {
      throw new BrainSearchVectorCapError(); } };
    expect(await refresh({ vectors: blind })).toMatchObject({ caughtUp: false, stopReason: "vector_cap",
      embedding: { tokens: fakeTokens("Title c\nBody for c"), stopped: "vector_cap" } });
  });

  it("embeds a revised document again in a full store: its own rows make room", async () => {
    const store = createBrainArrayVectorStore(h.db, { maxPerScope: 2 });
    await seeder.sync([{ seed: "a" }, { seed: "b" }]);
    expect(await refresh({ vectors: store })).toMatchObject({ caughtUp: true });
    await seeder.sync([{ seed: "a", body: "revised kittens" }]);
    expect(await refresh({ vectors: store })).toMatchObject({ processed: 1, caughtUp: true,
      embedding: { stopped: null } });
    expect(api.calls.at(-1)!.body.input).toEqual(["Title a\nrevised kittens"]);
    const view = await feature({ vectors: store }).service.search(OWNER, PROJECT_ID, { q: "kittens", mode: "hybrid" });
    expect(view.items[0]).toMatchObject({ hitId: brainDocumentId("a"), matchedBy: ["text", "vector"] });
  });

  it("never lets a pass that started on an older revision overwrite the newer revision's vectors", async () => {
    await seeder.sync([{ seed: "a", body: "first kittens" }]);
    let interleave: (() => Promise<unknown>) | null = async () => {
      await seeder.sync([{ seed: "a", body: "second gardens" }]);
      expect(await refresh()).toMatchObject({ processed: 1, caughtUp: true });
    };
    const slow: typeof globalThis.fetch = async (input, init) => {
      const run = interleave;
      interleave = null;
      await run?.();
      return api.fetch(input, init);
    };
    await refresh({ fetch: slow });
    const rows = await sql<{ revision: number }>`SELECT revision FROM brain_search_vectors`.execute(h.db);
    expect(rows.rows).toEqual([{ revision: 2 }]);
    expect(await feature().service.refresh(OWNER, PROJECT_ID)).toMatchObject({ caughtUp: true });
    const view = await feature().service.search(OWNER, PROJECT_ID, { q: "gardens", mode: "hybrid" });
    expect(view.items[0]).toMatchObject({ hitId: brainDocumentId("a"), matchedBy: ["text", "vector"] });
  });

  it("changes nothing without a key", async () => {
    const home = await mkdtemp(join(tmpdir(), "brain-embed-"));
    const embeddings = await createBrainSearchEmbeddings({ homePath: home, env: {} });
    await rm(home, { recursive: true, force: true });
    const textOnly = createBrainSearch({ repository: h.repository, resolver, capability: h.capability, embeddings,
      now: h.now });
    await seeder.sync([{ seed: "a" }]);
    expect(textOnly.service.capability()).toEqual(h.capability);
    expect(await textOnly.service.refresh(OWNER, PROJECT_ID)).toEqual({ index: "search", processed: 1, removed: 0,
      caughtUp: true, freshness: { caughtUp: true, pendingDocuments: 0, pendingCapped: false } });
  });
});
