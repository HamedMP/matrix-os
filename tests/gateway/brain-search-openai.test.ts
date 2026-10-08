/**
 * The OpenAI embeddings provider over a fake fetch: request shape, batching, dimensions, error mapping, retries,
 * usage and cost; then the owner config and key resolution (the owner's key, or OPENAI_API_KEY only when the owner
 * opts in with "${OPENAI_API_KEY}"), read on every call.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  brainOpenAiEmbeddingsCost, createBrainOpenAiEmbeddings,
} from "../../packages/gateway/src/brain/search/openai.js";
import { createBrainSearchEmbeddings } from "../../packages/gateway/src/brain/search/openai-config.js";
import { embedBrainTexts, isUsableBrainEmbeddingsProvider } from "../../packages/gateway/src/brain/search/vector.js";
import { fakeVector } from "./helpers/brain-search-fakes.js";
import {
  createOpenAiFetch, fakeTokens, openAiError, openAiSuccess,
} from "./helpers/brain-search-openai-fetch.js";

const KEY = "sk-proj-owner_0123456789abcdefABCDEF";
const ENV_KEY = "sk-env-0123456789abcdefABCDEF";
const signal = () => new AbortController().signal;

describe("brain search OpenAI embeddings", () => {
  let api: ReturnType<typeof createOpenAiFetch>;
  let waits: number[];
  const provider = (key: () => Promise<string | null> = async () => KEY, dimensions = 256) =>
    createBrainOpenAiEmbeddings({ dimensions, apiKey: key, fetch: api.fetch, random: () => 0,
      wait: async (ms) => { waits.push(ms); } });
  beforeEach(() => { api = createOpenAiFetch(); waits = []; });

  it("posts one bounded request and returns vectors in input order with usage and cost", async () => {
    const openai = provider();
    expect(openai).toMatchObject({ providerId: "openai/text-embedding-3-small/256", dimensions: 256, maxBatch: 32,
      maxInputChars: 2_730 });
    expect(isUsableBrainEmbeddingsProvider(openai)).toBe(true);
    const out = await openai.embedMetered(["alpha beta", "gamma"], signal());
    expect(out.vectors).toEqual([fakeVector("alpha beta", 256), fakeVector("gamma", 256)]);
    expect(out.usage).toEqual({ tokens: 5, costMicroUsd: 1 });
    const [call] = api.calls;
    expect(call!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(call!.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
    expect([call!.authorization, new Headers(call!.init.headers).get("content-type")])
      .toEqual([`Bearer ${KEY}`, "application/json"]);
    expect(call!.body).toEqual({ model: "text-embedding-3-small", input: ["alpha beta", "gamma"], dimensions: 256,
      encoding_format: "float" });
    expect(await openai.embed(["x"], signal())).toEqual([fakeVector("x", 256)]);
    expect([0, 1, 50, 51, 1_000_000].map(brainOpenAiEmbeddingsCost)).toEqual([0, 1, 1, 2, 20_000]);
  });

  it("batches at most 32 inputs per call, cuts each at 2,730 characters and sums usage", async () => {
    const texts = Array.from({ length: 70 }, (_, index) => `text ${index}`);
    texts[0] = "x".repeat(3_000);
    const result = await embedBrainTexts(provider(), texts, signal());
    expect(api.calls.map((call) => call.body.input.length)).toEqual([32, 32, 6]);
    expect(api.calls[0]!.body.input[0]).toHaveLength(2_730);
    expect(result.vectors).toHaveLength(70);
    const billed = api.calls.map((call) => call.body.input.reduce((sum, text) => sum + fakeTokens(text), 0));
    expect(billed[0]).toBe(fakeTokens("x".repeat(2_730)) + texts.slice(1, 32).reduce((sum, text) => sum + fakeTokens(text), 0));
    // Each response's cost is rounded up on its own.
    expect(result).toMatchObject({ tokens: billed[0]! + billed[1]! + billed[2]!,
      costMicroUsd: billed.reduce((sum, tokens) => sum + Math.ceil(tokens / 50), 0) });
  });

  it("asks for 1 to 1,536 dimensions only", async () => {
    for (const dimensions of [0, 1_537, 1.5]) expect(() => provider(undefined, dimensions)).toThrow(RangeError);
    api = createOpenAiFetch(8);
    const small = provider(undefined, 8);
    expect(small.providerId).toBe("openai/text-embedding-3-small/8");
    expect(await small.embed(["a"], signal())).toEqual([fakeVector("a", 8)]);
    expect(api.calls[0]!.body.dimensions).toBe(8);
    await expect(small.embed([], signal())).rejects.toMatchObject({ code: "invalid" });
    expect(api.calls).toHaveLength(1);
  });

  it("maps refusals without retrying", async () => {
    const cases = [[400, null, "invalid"], [413, null, "invalid"], [422, null, "invalid"],
      [401, "invalid_api_key", "auth_failed"], [403, null, "auth_failed"], [404, "model_not_found", "auth_failed"],
      [429, "insufficient_quota", "unavailable"], [418, "Not A Slug!", "unavailable"]] as const;
    const openai = provider();
    for (const [status, code, expected] of cases) {
      api.queue.push(openAiError(status, code));
      await expect(openai.embed(["a"], signal())).rejects.toMatchObject({ name: "BrainEmbeddingsError", code: expected,
        status, detail: code === "Not A Slug!" ? null : code, message: `Embeddings ${expected}` });
    }
    api.queue.push(new Response("<html>", { status: 400 }));
    await expect(openai.embed(["a"], signal())).rejects.toMatchObject({ code: "invalid", detail: null });
    expect([api.calls.length, waits]).toEqual([cases.length + 1, []]);
  });

  it("retries rate limits, server errors and network failures twice, honoring short retry waits", async () => {
    const openai = provider();
    api.queue.push(openAiError(429, "rate_limit_exceeded", { "retry-after": "1" }),
      openAiError(503, null, { "retry-after-ms": "40" }));
    expect(await openai.embed(["a"], signal())).toHaveLength(1);
    expect(waits).toEqual([1_000, 40]);
    waits = [];
    api.queue.push(openAiError(500, null), openAiError(502, "server_error"), openAiError(504, null));
    await expect(openai.embed(["a"], signal())).rejects.toMatchObject({ code: "unavailable", status: 504 });
    expect(waits).toEqual([250, 500]);
    waits = [];
    const network = new TypeError("fetch failed");
    api.queue.push(network, network, network);
    await expect(openai.embed(["a"], signal())).rejects.toMatchObject({ code: "unavailable", status: null, cause: network });
    waits = [];
    api.queue.push(openAiError(408, null, { "retry-after": new Date(Date.now() + 1_500).toUTCString() }),
      openAiError(409, null, { "retry-after": "soon" }));
    expect(await openai.embed(["a"], signal())).toHaveLength(1);
    expect([waits[0]! > 0 && waits[0]! <= 1_500, waits[1]]).toEqual([true, 500]);
    waits = [];
    api.queue.push(openAiError(429, null, { "retry-after-ms": "x" }));
    expect(await openai.embed(["a"], signal())).toHaveLength(1);
    expect(waits).toEqual([250]);
    const before = api.calls.length;
    api.queue.push(openAiError(429, "rate_limit_exceeded", { "retry-after": "3" }));
    await expect(openai.embed(["a"], signal())).rejects.toMatchObject({ code: "unavailable", status: 429 });
    api.queue.push(openAiError(503, null, { "x-should-retry": "false" }));
    await expect(openai.embed(["a"], signal())).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(api.calls.length - before).toBe(2);
  });

  it("rethrows a caller abort untouched, during a call or a wait", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    api.queue.push(() => { controller.abort(reason); throw new DOMException("aborted", "AbortError"); });
    await expect(provider().embed(["a"], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const later = new AbortController();
    const waiting = createBrainOpenAiEmbeddings({ dimensions: 256, apiKey: async () => KEY, fetch: api.fetch,
      wait: async (_ms, waitSignal) => { later.abort(reason); waitSignal.throwIfAborted(); } });
    api.queue.push(openAiError(503, null));
    await expect(waiting.embed(["a"], later.signal)).rejects.toBe(reason);
    const timed = createBrainOpenAiEmbeddings({ dimensions: 256, apiKey: async () => KEY, fetch: api.fetch });
    api.queue.push(openAiError(503, null, { "retry-after-ms": "1" }));
    expect(await timed.embed(["a"], signal())).toHaveLength(1);
  });

  it("refuses unusable answers as unavailable, without retrying", async () => {
    const vector = fakeVector("a", 256);
    const bodies: Response[] = [
      openAiSuccess(["a"], 256, { data: [] }),
      openAiSuccess(["a"], 256, { data: [{ index: 0, embedding: vector.slice(1) }] }),
      openAiSuccess(["a", "b"], 256, { data: [{ index: 0, embedding: vector }, { index: 0, embedding: vector }] }),
      openAiSuccess(["a"], 256, { data: [{ index: 3, embedding: vector }] }),
      openAiSuccess(["a"], 256, { data: [{ index: 0, embedding: vector.map(String) }] }),
      Response.json({ data: [{ index: 0, embedding: vector }] }),
      new Response("not json", { status: 200 }),
      new Response("{}", { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } }),
    ];
    const openai = provider();
    for (const body of bodies) {
      api.queue.push(body);
      const texts = body === bodies[2] ? ["a", "b"] : ["a"];
      await expect(openai.embed(texts, signal())).rejects.toMatchObject({ code: "unavailable", status: 200 });
    }
    expect(api.calls).toHaveLength(bodies.length);
  });

  it("is not_configured without a key and reads the key on every call", async () => {
    let key: string | null = null;
    const openai = provider(async () => key);
    await expect(openai.embed(["a"], signal())).rejects.toMatchObject({ code: "not_configured" });
    expect(api.calls).toHaveLength(0);
    key = KEY;
    await openai.embed(["a"], signal());
    key = ENV_KEY;
    await openai.embed(["a"], signal());
    expect(api.calls.map((call) => call.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${ENV_KEY}`]);
  });
});

describe("brain search embeddings config", () => {
  let home: string;
  let api: ReturnType<typeof createOpenAiFetch>;
  const logs: unknown[][] = [];
  const config = join("system", "config.json");
  const write = (embeddings: unknown) => writeFile(join(home, config), JSON.stringify({ brain: { embeddings } }));
  const GIT = ["git_pr", "git_commit", "git_spec"];
  const create = (env: Record<string, string | undefined>) =>
    createBrainSearchEmbeddings({ homePath: home, env, fetch: api.fetch });
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "brain-embed-"));
    await mkdir(join(home, "system"));
    api = createOpenAiFetch();
    logs.length = 0;
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args); });
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    expect(JSON.stringify(logs)).not.toContain("sk-");
    await rm(home, { recursive: true, force: true });
  });

  it("takes the owner's key, or OPENAI_API_KEY only when the owner opts in and no relay base URL is set", async () => {
    await write({ openai_key: ` ${KEY} `, model: "text-embedding-3-small", dimensions: 256 });
    const openai = (await create({ OPENAI_API_KEY: ENV_KEY }))!;
    expect(openai.providerId).toBe("openai/text-embedding-3-small/256");
    await openai.embed(["a"], signal());
    await write({ openai_key: "${OPENAI_API_KEY}", model: "text-embedding-3-small", dimensions: 256 });
    await openai.embed(["a"], signal());
    expect(api.calls.map((call) => call.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${ENV_KEY}`]);
    expect(logs).toContainEqual(["[brain-search] OpenAI embeddings on",
      { source: "owner_key", dimensions: 256, provenances: GIT }]);
    for (const env of [{ OPENAI_API_KEY: ENV_KEY, OPENAI_BASE_URL: "https://relay.example" }, {},
      { OPENAI_API_KEY: "${OPENAI_API_KEY}" }]) expect(await create(env)).toBeNull();
    expect(await create({ OPENAI_API_KEY: ENV_KEY, OPENAI_BASE_URL: " " })).not.toBeNull();
    expect(logs).toContainEqual(["[brain-search] OpenAI embeddings on",
      { source: "environment", dimensions: 256, provenances: GIT }]);
    // The real fetch is only taken, never called, here.
    expect(await createBrainSearchEmbeddings({ homePath: home, env: { OPENAI_API_KEY: ENV_KEY } })).not.toBeNull();
    // The shipped empty key, a null key or no file: off, whatever the environment holds; clearing the key stops calls.
    await write({ openai_key: "", model: "text-embedding-3-small", dimensions: 256 });
    await expect(openai.embed(["a"], signal())).rejects.toMatchObject({ code: "not_configured" });
    expect(await create({ OPENAI_API_KEY: ENV_KEY })).toBeNull();
    await write({ openai_key: null });
    expect(await create({ OPENAI_API_KEY: ENV_KEY })).toBeNull();
    await rm(join(home, config));
    expect(await create({ OPENAI_API_KEY: ENV_KEY })).toBeNull();
    expect(api.calls).toHaveLength(2);
    await writeFile(join(home, "real.json"), JSON.stringify({ brain: { embeddings: { openai_key: KEY } } }));
    await symlink(join(home, "real.json"), join(home, config));
    expect(await create({})).toBeNull();
    await rm(join(home, config));
    await write({ openai_key: "${OPENAI_API_KEY}", dimensions: 64 });
    expect((await create({ OPENAI_API_KEY: ENV_KEY }))?.providerId).toBe("openai/text-embedding-3-small/64");
  });

  it("turns off on an invalid setting, naming only the field", async () => {
    const cases = [["model", { model: "text-embedding-3-large", openai_key: KEY }],
      ["dimensions", { dimensions: 2_000, openai_key: KEY }], ["dimensions", { dimensions: "256", openai_key: KEY }],
      ["openai_key", { openai_key: "not-a-key" }], ["openai_key", { openai_key: 42 }],
      ["openai_key", { openai_key: "${OTHER_API_KEY}" }], ["provenances", { openai_key: KEY, provenances: [] }],
      ["provenances", { openai_key: KEY, provenances: ["git_pr", "git_pr"] }],
      ["provenances", { openai_key: KEY, provenances: ["secrets"] }],
      ["provenances", { openai_key: KEY, provenances: "matrix_chat" }]] as const;
    for (const [field, embeddings] of cases) {
      await write(embeddings);
      expect(await create({ OPENAI_API_KEY: ENV_KEY })).toBeNull();
      expect(logs.at(-1)).toEqual(["[brain-search] embeddings disabled by an invalid setting", { field }]);
    }
  });

  it("needs the brain's own opt-in, never tools.embeddings, and sends git documents only unless more are listed", async () => {
    // A key set up for another feature (the old tools.embeddings block) never turns brain embeddings on.
    await writeFile(join(home, config), JSON.stringify({ tools: { embeddings: { openai_key: KEY } } }));
    expect(await create({ OPENAI_API_KEY: ENV_KEY })).toBeNull();
    await write({ openai_key: KEY });
    expect((await create({}))?.provenances).toEqual(GIT);
    await write({ openai_key: KEY, provenances: ["git_pr", "matrix_note"] });
    expect((await create({}))?.provenances).toEqual(["git_pr", "matrix_note"]);
    expect(api.calls).toHaveLength(0);
  });

  it("reads the allowed provenances again on demand, so a narrowed list applies without a restart", async () => {
    await write({ openai_key: KEY, provenances: ["git_pr", "matrix_chat"] });
    const openai = (await create({}))!;
    expect(openai.provenances).toEqual(["git_pr", "matrix_chat"]);
    expect(await openai.currentProvenances!()).toEqual(["git_pr", "matrix_chat"]);
    await write({ openai_key: KEY, provenances: ["git_pr"] });
    expect(await openai.currentProvenances!()).toEqual(["git_pr"]);
    await write({ openai_key: KEY });
    expect(await openai.currentProvenances!()).toEqual(GIT);
    // Settings that turned invalid, or a file that is gone, allow nothing.
    await write({ openai_key: KEY, provenances: ["not a provenance"] });
    expect(await openai.currentProvenances!()).toEqual([]);
    await rm(join(home, config));
    expect(await openai.currentProvenances!()).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  it("stops at call time when the key goes away", async () => {
    await write({ openai_key: KEY });
    const openai = (await create({}))!;
    await write({ openai_key: "" });
    await expect(openai.embed(["a"], signal())).rejects.toMatchObject({ code: "not_configured" });
    await write({ model: "other", openai_key: KEY });
    await expect(openai.embed(["a"], signal())).rejects.toMatchObject({ code: "not_configured" });
    expect(api.calls).toHaveLength(0);
  });
});
