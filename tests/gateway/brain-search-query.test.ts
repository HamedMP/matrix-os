/** Search query parsing: term grammar, bounds, filters, fingerprints and cursors (pure). */
import { describe, expect, it } from "vitest";
import {
  brainSearchCursorMode, brainSearchFingerprint, decodeBrainSearchCursor, encodeBrainSearchCursor,
  parseBrainSearchQuery, parseBrainSearchTerms,
} from "../../packages/gateway/src/brain/search/query.js";
import { brainTsQuery } from "../../packages/gateway/src/brain/search/text.js";

const invalid = (fn: () => unknown) =>
  expect(fn).toThrow(expect.objectContaining({ name: "BrainApiError", code: "invalid_request" }));

describe("brain search terms", () => {
  it("keeps joined words, splits other punctuation and reads phrases and prefixes", () => {
    expect(parseBrainSearchTerms(`package.json "keep one  transaction" bran* x* ENG-42, (scope) a*b`).terms).toEqual([
      { type: "plain", text: "package.json" }, { type: "phrase", text: "keep one transaction" },
      { type: "prefix", text: "bran" }, { type: "plain", text: "x" }, { type: "plain", text: "ENG-42" },
      { type: "prefix", text: "scope" }, { type: "plain", text: "b" },
    ]);
  });

  it("drops English stop words, matches words of 4+ letters by their stem, and keeps a stop-word-only query", () => {
    const terms = (q: string) => parseBrainSearchTerms(q).terms;
    expect(terms("how does onboarding readiness work")).toEqual([
      { type: "prefix", text: "onboard" }, { type: "prefix", text: "readiness" }, { type: "prefix", text: "work" },
    ]);
    expect(terms("collaboration grants")).toEqual(terms("collaboration grant"));
    expect(terms("onboarding OR billing").map((term) => term.text)).toEqual(["onboard", "bill"]);
    expect(terms("what are the policies on boxes")).toEqual([
      { type: "prefix", text: "polic" }, { type: "prefix", text: "boxes" },
    ]);
    expect(terms("the")).toEqual([{ type: "plain", text: "the" }]);
    expect(terms(`"the plan" to`)).toEqual([{ type: "phrase", text: "the plan" }]);
  });

  it("keeps a joined prefix whole, refuses an unsafe one and drops empty pieces", () => {
    expect(parseBrainSearchTerms(`company-br* package.js* src/b* --- "" "unclosed phrase ... *`).terms).toEqual([
      { type: "prefix", text: "company-br" }, { type: "prefix", text: "package.js" }, { type: "prefix", text: "src/b" },
      { type: "phrase", text: "unclosed phrase" },
    ]);
    expect(() => brainTsQuery([{ type: "prefix", text: "a'b" }])).toThrow("Unsafe prefix term");
    expect(parseBrainSearchTerms("*** ... !!").terms).toEqual([]);
    expect(parseBrainSearchTerms("\u00dcber* na\u00efve \u6771\u4eac").terms).toEqual([
      { type: "prefix", text: "\u00dcber" }, { type: "prefix", text: "na\u00efve" }, { type: "plain", text: "\u6771\u4eac" },
    ]);
  });

  it("keeps 16 terms and says when more were dropped", () => {
    const many = Array.from({ length: 20 }, (_, index) => `t${index}`).join(" ");
    const parsed = parseBrainSearchTerms(many);
    expect([parsed.terms.length, parsed.dropped, parsed.terms[15]]).toEqual([16, true, { type: "plain", text: "t15" }]);
    expect(parseBrainSearchTerms("a b").dropped).toBe(false);
  });
});

describe("brain search query", () => {
  it("applies defaults and normalizes filters", () => {
    const parsed = parseBrainSearchQuery({ q: "alpha", from: "2026-09-01", to: "2026-10-01T12:00:00+02:00",
      path: "src/", kinds: ["pr"], claimKinds: ["risk"], sourceId: `src_${"a".repeat(32)}`, types: ["claim"],
      mode: "text", limit: 5, cursor: "abc" });
    expect(parsed).toMatchObject({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T10:00:00.000Z",
      path: { value: "src", mode: "under" }, kinds: ["pr"], claimKinds: ["risk"], types: ["claim"], limit: 5,
      cursor: "abc", termsDropped: false });
    expect(parseBrainSearchQuery({ q: "a", path: "src/a.ts" })).toMatchObject({
      types: ["document", "claim"], kinds: null, claimKinds: null, sourceId: null, from: null, to: null,
      path: { value: "src/a.ts", mode: "exact_or_under" }, mode: "auto", limit: 20, cursor: null });
  });

  it("refuses bad input with invalid_request", () => {
    for (const bad of [
      { q: "   " }, { q: "a".repeat(501) }, { q: "a", types: [] }, { q: "a", types: ["document", "document"] },
      { q: "a", kinds: ["nope"] }, { q: "a", sourceId: "src_x" }, { q: "a", from: "2026-02-30" },
      { q: "a", from: "0000-01-01" }, { q: "a", from: "yesterday" }, { q: "a", to: "2026-10-01T10:00:00" },
      { q: "a", from: "2026-10-02", to: "2026-10-01" }, { q: "a", path: "../x" }, { q: "a", limit: 51 },
      { q: "a", extra: 1 },
    ]) invalid(() => parseBrainSearchQuery(bad as never));
  });
});

describe("brain search cursors", () => {
  const query = parseBrainSearchQuery({ q: "alpha", kinds: ["pr", "commit"] });

  it("fingerprints the query, filters and mode, ignoring list order", () => {
    const text = brainSearchFingerprint(query, "text");
    expect(text).toMatch(/^[a-f0-9]{16}$/);
    expect(brainSearchFingerprint(parseBrainSearchQuery({ q: "alpha", kinds: ["commit", "pr"] }), "text")).toBe(text);
    expect(brainSearchFingerprint(query, "hybrid")).not.toBe(text);
    expect(brainSearchFingerprint(parseBrainSearchQuery({ q: "alpha" }), "text")).not.toBe(text);
  });

  it("round-trips text and hybrid cursors and refuses foreign or broken ones", () => {
    const f = brainSearchFingerprint(query, "text");
    const text = encodeBrainSearchCursor({ v: 1, m: "t", f, s: "0.500000", h: "a".repeat(64) });
    expect(decodeBrainSearchCursor(text, f, "t")).toEqual({ v: 1, m: "t", f, s: "0.500000", h: "a".repeat(64) });
    const hybrid = encodeBrainSearchCursor({ v: 1, m: "h", f, o: 20 });
    expect(decodeBrainSearchCursor(hybrid, f, "h")).toMatchObject({ o: 20 });
    expect([brainSearchCursorMode(text), brainSearchCursorMode(hybrid)]).toEqual(["t", "h"]);
    const json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const [cursor, mode] of [
      [text, "h"], [hybrid, "t"], [encodeBrainSearchCursor({ v: 1, m: "t", f: "0".repeat(16), s: "0.500000",
        h: "a".repeat(64) }), "t"], ["not base64!", "t"], [Buffer.from("{nope").toString("base64url"), "t"],
      [json({ v: 2, m: "t", f, s: "0.5", h: "x" }), "t"], [json({ v: 1, m: "h", f, o: 201 }), "h"],
    ] as const) invalid(() => decodeBrainSearchCursor(cursor, f, mode));
  });
});
