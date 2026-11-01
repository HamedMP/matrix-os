/** Snippets, cites, chunking, embeddings checks and rank fusion (pure). */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BRAIN_SEARCH_SNIPPET_MAX_CHARS } from "../../packages/gateway/src/brain/contracts.js";
import { parseBrainSearchTerms } from "../../packages/gateway/src/brain/search/query.js";
import {
  brainSearchPatterns, buildBrainSnippet, chunkBrainSnippet, findBrainSearchMatches, pickBrainSnippet,
} from "../../packages/gateway/src/brain/search/snippet.js";
import { BrainEmbeddingsError, type BrainRankedHit } from "../../packages/gateway/src/brain/search/types.js";
import {
  BrainEmbeddingsOutputError, brainEmbedChunks, brainEmbeddingsFailure, chunkBrainBody, embedBrainTexts,
  fuseBrainHits, isUsableBrainEmbeddingsProvider, rankBrainVectorDocuments,
} from "../../packages/gateway/src/brain/search/vector.js";
import { fakeProvider } from "./helpers/brain-search-fakes.js";

const patterns = (q: string) => brainSearchPatterns(parseBrainSearchTerms(q).terms);
const textKey = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
const slices = (text: string, ranges: readonly (readonly [number, number])[]) => ranges.map(([a, b]) => text.slice(a, b));

describe("brain search snippets", () => {
  it("highlights whole words, prefixes and phrases case-insensitively and merges overlaps", () => {
    const text = "Keep ONE transaction per document; transactions are short. Brainy brain_why one-transaction.";
    const found = findBrainSearchMatches(text, patterns(`"keep one transaction" transact* brain`));
    expect(slices(text, found)).toEqual(["Keep ONE transaction", "transactions", "Brainy", "brain", "transaction"]);
    expect(findBrainSearchMatches("axb a.b", brainSearchPatterns([{ type: "plain", text: "a.b" }]))).toEqual([[4, 7]]);
  });

  it("ends a window on the space after the last whole highlight and never highlights a cut word", () => {
    const text = `${"w".repeat(264)} terminal sessions after`;
    const snippet = buildBrainSnippet("body", text, findBrainSearchMatches(text, patterns("terminal sessions")), 0);
    expect(snippet.text.endsWith(" terminal")).toBe(true);
    expect(slices(snippet.text, snippet.highlights)).toEqual(["terminal"]);
    const cut = buildBrainSnippet("body", "w".repeat(400), [[270, 290]], 0);
    expect([cut.text.length, cut.highlights]).toEqual([280, []]);
  });

  it("keeps short text whole and windows long text around the densest matches", () => {
    expect(buildBrainSnippet("title", "Short title", [[0, 5]])).toEqual({
      field: "title", text: "Short title", highlights: [[0, 5]], truncatedStart: false, truncatedEnd: false });
    const text = `${"lead words ".repeat(40)}alpha beta alpha ${"tail words ".repeat(40)}`;
    const snippet = buildBrainSnippet("body", text, findBrainSearchMatches(text, patterns("alpha")));
    expect(snippet.text.length).toBeLessThanOrEqual(BRAIN_SEARCH_SNIPPET_MAX_CHARS);
    expect([snippet.truncatedStart, snippet.truncatedEnd]).toEqual([true, true]);
    expect(slices(snippet.text, snippet.highlights)).toEqual(["alpha", "alpha"]);
    expect(snippet.text).toMatch(/^(lead|words) /);
    const start = buildBrainSnippet("body", text, []);
    expect([start.text.slice(0, 10), start.truncatedStart, start.highlights]).toEqual(["lead words", false, []]);
  });

  it("never splits a surrogate pair and caps highlights at 16", () => {
    const emoji = "\u{1F600}";
    const text = `${emoji.repeat(200)} x`;
    const snippet = buildBrainSnippet("body", text, []);
    expect(snippet.text.isWellFormed()).toBe(true);
    const dense = "x ".repeat(300);
    expect(findBrainSearchMatches(dense, patterns("x"))).toHaveLength(256);
    expect(buildBrainSnippet("body", dense, findBrainSearchMatches(dense, patterns("x"))).highlights).toHaveLength(16);
    const solid = `${"y".repeat(400)} alpha${"z".repeat(400)}`;
    const unbroken = buildBrainSnippet("body", solid, findBrainSearchMatches(solid, patterns("alpha*")));
    expect([unbroken.text.length, unbroken.truncatedStart, unbroken.truncatedEnd]).toEqual([280, true, true]);
    const early = buildBrainSnippet("body", `alpha ${"w ".repeat(200)}`, [[0, 5]]);
    expect([early.truncatedStart, early.highlights]).toEqual([false, [[0, 5]]]);
    expect(chunkBrainSnippet("short", 10_000, [])).toMatchObject({ text: "", truncatedStart: true, truncatedEnd: false });
    const windowed = buildBrainSnippet("body", `${"a".repeat(300)}${emoji} hit`, [[302, 305]], 299);
    expect([windowed.text.isWellFormed(), windowed.truncatedStart]).toEqual([true, true]);
  });

  it("picks the first matching field, else the fallback, and anchors chunk snippets", () => {
    const fields = [{ field: "statement", text: "no hit here" }, { field: "quote", text: "the alpha quote" }] as const;
    expect(pickBrainSnippet(fields, patterns("alpha"))).toMatchObject({ field: "quote", highlights: [[4, 9]] });
    expect(pickBrainSnippet(fields, patterns("zeta"))).toMatchObject({ field: "statement", highlights: [] });
    const body = `${"x ".repeat(300)}chunk start alpha ${"y ".repeat(300)}`;
    const chunk = chunkBrainSnippet(body, 600, patterns("alpha"));
    expect([chunk.text.startsWith("chunk start"), chunk.truncatedStart, chunk.truncatedEnd]).toEqual([true, true, true]);
    expect(slices(chunk.text, chunk.highlights)).toEqual(["alpha"]);
  });
});

describe("brain search meaning helpers", () => {
  it("chunks bodies with overlap, preferred cuts and the per-document cap", () => {
    expect(chunkBrainBody("")).toEqual([]);
    expect(chunkBrainBody("short")).toEqual([{ spanStart: 0, spanEnd: 5 }]);
    const lines = `${"word ".repeat(300)}\n${"word ".repeat(300)}`;
    const spans = chunkBrainBody(lines);
    expect(spans[0]).toEqual({ spanStart: 0, spanEnd: 1_501 });
    expect(spans[1]!.spanStart).toBe(1_301);
    expect(chunkBrainBody("x".repeat(100_000))).toHaveLength(40);
    const hard = chunkBrainBody(`${"x".repeat(1_999)}\u{1F600}${"x".repeat(10)}`);
    expect(hard[0]!.spanEnd).toBe(1_999);
  });

  it("checks provider settings and every returned vector", async () => {
    expect(isUsableBrainEmbeddingsProvider(fakeProvider())).toBe(true);
    for (const bad of [{ providerId: "Bad Id" }, { dimensions: 0 }, { dimensions: 5_000 }, { maxBatch: 1.5 },
      { maxInputChars: 0 }]) expect(isUsableBrainEmbeddingsProvider(fakeProvider(bad))).toBe(false);
    const provider = fakeProvider({ maxBatch: 2, maxInputChars: 3 });
    const { vectors, tokens } = await embedBrainTexts(provider, ["alpha", "beta", "\u{1F600}\u{1F600}"],
      new AbortController().signal);
    expect([vectors.length, tokens, provider.calls]).toEqual([3, 0, [["alp", "bet"], ["\u{1F600}"]]]);
    const last = (value: number) => [[...new Array(15).fill(0), value]];
    for (const output of [[[1]], [], "nope", last(Number.NaN), last(-1e39)]) {
      provider.fail = () => output;
      await expect(embedBrainTexts(provider, ["a"], new AbortController().signal)).rejects.toBeInstanceOf(BrainEmbeddingsOutputError);
    }
  });

  it("sums metered usage, refuses bad usage and maps its own deadline to unavailable", async () => {
    const usage = { tokens: 3, costMicroUsd: 1 };
    const metered = Object.assign(fakeProvider({ maxBatch: 1 }), {
      embedMetered: async (texts: readonly string[], signal: AbortSignal) =>
        ({ vectors: await metered.embed(texts, signal), usage }),
    });
    expect(await embedBrainTexts(metered, ["a", "b"], new AbortController().signal))
      .toMatchObject({ tokens: 6, costMicroUsd: 2 });
    for (const bad of [{ tokens: -1, costMicroUsd: 0 }, { tokens: 1, costMicroUsd: 0.5 }]) {
      Object.assign(usage, bad);
      await expect(embedBrainTexts(metered, ["a"], new AbortController().signal)).rejects.toBeInstanceOf(BrainEmbeddingsOutputError);
    }
    const provider = fakeProvider();
    provider.fail = true;
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(AbortSignal.abort());
    const error = await embedBrainTexts(provider, ["a"], new AbortController().signal).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ name: "BrainEmbeddingsError", code: "unavailable" });
    expect([brainEmbeddingsFailure(error), brainEmbeddingsFailure(new BrainEmbeddingsError("invalid", { status: 400,
      detail: "bad" })), brainEmbeddingsFailure("x")]).toEqual(["unavailable", "invalid 400 bad", "UnknownError"]);
    const aborted = new AbortController();
    aborted.abort();
    await expect(embedBrainTexts(provider, ["a"], aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    vi.restoreAllMocks();
  });

  it("embeds at most 39 body chunks, then one chunk of claim statements, each led by the title", () => {
    const body = "x ".repeat(50_000);
    const chunks = brainEmbedChunks("T", body, `${"claim ".repeat(400)}\u{1F600}`);
    expect(chunks).toHaveLength(40);
    expect(chunks.slice(0, 39).map(({ spanStart, spanEnd }) => ({ spanStart, spanEnd })))
      .toEqual(chunkBrainBody(body).slice(0, 39));
    expect(chunks[0]!.text).toBe(`T\n${body.slice(0, chunks[0]!.spanEnd)}`);
    const claims = `T\n${"claim ".repeat(400).slice(0, 2_000)}`;
    expect(chunks[39]).toEqual({ spanStart: 0, spanEnd: 2_000, text: claims, textKey: textKey(claims) });
    expect(brainEmbedChunks("T", "short", "")).toEqual([{ spanStart: 0, spanEnd: 5, text: "T\nshort",
      textKey: textKey("T\nshort") }]);
    expect(brainEmbedChunks("T", "", "a rule")).toEqual([{ spanStart: 0, spanEnd: 6, text: "T\na rule",
      textKey: textKey("T\na rule") }]);
    // The key follows the text sent: a new title changes every key.
    expect(brainEmbedChunks("U", "short", "")[0]!.textKey).not.toBe(textKey("T\nshort"));
  });

  it("ranks vector documents once and fuses lists with normalized reciprocal ranks", () => {
    const at = (documentId: string, revision: number) => ({ documentId, incarnation: "i", revision });
    expect(rankBrainVectorDocuments([{ ...at("b", 2), chunkIndex: 2, distance: 0.1 },
      { ...at("a", 1), chunkIndex: 0, distance: 0.2 }, { ...at("b", 2), chunkIndex: 0, distance: 0.3 }]))
      .toEqual([{ ...at("b", 2), chunkIndex: 2 }, { ...at("a", 1), chunkIndex: 0 }]);
    const hit = (hitId: string, by: "text" | "vector", chunkIndex: number | null = null): BrainRankedHit => ({
      type: "document", hitId, documentId: hitId, claimId: null, extractor: null, score: "0.000000",
      matchedBy: [by], chunkIndex });
    const fused = fuseBrainHits([[hit("a", "text"), hit("b", "text")], [hit("b", "vector", 3), hit("c", "vector", 1)]]);
    expect(fused.map((entry) => [entry.hitId, entry.score, entry.matchedBy, entry.chunkIndex])).toEqual([
      ["b", "0.991935", ["text", "vector"], 3], ["a", "0.500000", ["text"], null], ["c", "0.491935", ["vector"], 1]]);
    expect(fuseBrainHits([[hit("x", "text"), hit("w", "text")], []]).map((entry) => entry.score))
      .toEqual(["1.000000", "0.983871"]);
    expect(fuseBrainHits([[hit("b", "text")], [hit("a", "vector")]]).map((entry) => entry.hitId)).toEqual(["a", "b"]);
  });
});
