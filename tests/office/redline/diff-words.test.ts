import { describe, expect, it } from "vitest";
import { isOfficeError } from "../../../packages/office/src/errors.js";
import { diffSequences, diffWords, tokenize } from "../../../packages/office/src/redline/index.js";
import { alignSequences } from "../../../packages/office/src/redline/myers.js";
import { brief, expectValidDiff, expectValidSequenceDiff, mutate, randomText, rng } from "./helpers.js";

describe("tokenize", () => {
  it("splits into words, whitespace runs and single other characters", () => {
    expect(tokenize("Don't pay  10%, OK?")).toEqual(["Don't", " ", "pay", "  ", "10", "%", ",", " ", "OK", "?"]);
  });

  it("keeps accented and combining letters inside one word", () => {
    expect(tokenize("naïve cafe\u0301 Zürich")).toEqual(["naïve", " ", "cafe\u0301", " ", "Zürich"]);
  });

  it("treats quotes around a word as separate tokens", () => {
    expect(tokenize("'quoted' it’s")).toEqual(["'", "quoted", "'", " ", "it’s"]);
  });

  it("never splits a surrogate pair", () => {
    expect(tokenize("a😀b", "char")).toEqual(["a", "😀", "b"]);
    expect(tokenize("ok 😀!")).toEqual(["ok", " ", "😀", "!"]);
  });

  it("segments text written without spaces, with and without Intl.Segmenter", () => {
    for (const useSegmenter of [true, false]) {
      const tokens = tokenize("契約は東京で締結された。", "word", { segmenter: useSegmenter });
      expect(tokens.join("")).toBe("契約は東京で締結された。");
      expect(tokens.length).toBeGreaterThan(3);
      expect(tokens.at(-1)).toBe("。");
    }
  });

  it("covers the input exactly for arbitrary text", () => {
    const random = rng(7);
    for (let i = 0; i < 50; i += 1) {
      const text = randomText(random, 40) + "\u0000\uD800 \t\r\n ไทย 中文 text";
      expect(tokenize(text).join("")).toBe(text);
      expect(tokenize(text, "char").join("")).toBe(text);
    }
  });
});

/** Length of the longest common subsequence by dynamic programming, as an oracle. */
function lcsLength(a: Int32Array, b: Int32Array): number {
  let previous = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Int32Array(b.length + 1);
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = a[i - 1] === b[j - 1] ? (previous[j - 1] as number) + 1 : Math.max(previous[j] as number, row[j - 1] as number);
    }
    previous = row;
  }
  return previous[b.length] as number;
}

function expectAlignment(a: Int32Array, b: Int32Array, match: Int32Array): number {
  let last = -1;
  let matched = 0;
  match.forEach((j, i) => {
    if (j < 0) return;
    expect(a[i]).toBe(b[j]);
    expect(j).toBeGreaterThan(last);
    last = j;
    matched += 1;
  });
  return matched;
}

describe("Myers alignment", () => {
  const codes = (text: string): Int32Array => Int32Array.from(text, (c) => c.charCodeAt(0));

  it("finds a longest common subsequence on the textbook example", () => {
    const a = codes("ABCABBA");
    const b = codes("CBABAC");
    expect(expectAlignment(a, b, alignSequences(a, b, { left: 1e6 }))).toBe(4);
  });

  it("is optimal with the saved trace and with the linear-space search", () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const random = rng(seed);
      // Small alphabets give many competing alignments; the long cases exceed the greedy trace.
      const length = seed <= 20 ? 5 + Math.floor(random() * 60) : 900 + Math.floor(random() * 300);
      const alphabet = seed <= 20 ? 3 : 4;
      const a = Int32Array.from({ length }, () => Math.floor(random() * alphabet));
      const b = Int32Array.from({ length: Math.max(0, length + Math.floor(random() * 20) - 10) }, () => Math.floor(random() * alphabet));
      const matched = expectAlignment(a, b, alignSequences(a, b, { left: 1e9 }));
      expect(matched, `seed ${seed}`).toBe(lcsLength(a, b));
    }
  });

  it("stays valid when the work budget runs out", () => {
    const random = rng(4);
    const a = Int32Array.from({ length: 3000 }, () => Math.floor(random() * 50));
    const b = Int32Array.from({ length: 3000 }, () => Math.floor(random() * 50));
    const budget = { left: 5000 };
    const matched = expectAlignment(a, b, alignSequences(a, b, budget));
    expect(budget.left).toBeLessThanOrEqual(0);
    expect(matched).toBeLessThan(lcsLength(a, b));
  });
});

describe("diffWords: classic cases", () => {
  it("returns nothing for two empty texts and one equal op for identical texts", () => {
    expect(diffWords("", "")).toEqual([]);
    expect(diffWords("same text", "same text")).toEqual([
      { type: "equal", text: "same text", aStart: 0, aEnd: 9, bStart: 0, bEnd: 9, moveId: null },
    ]);
  });

  it("reports a pure insertion and a pure deletion", () => {
    expect(brief(diffWords("", "new"))).toEqual(["+new"]);
    expect(brief(diffWords("old", ""))).toEqual(["-old"]);
  });

  it("replaces one word and keeps the rest", () => {
    const ops = diffWords("The cat sat on the mat", "The dog sat on the mat");
    expect(brief(ops)).toEqual(["=The ", "-cat", "+dog", "= sat on the mat"]);
    expect(ops[1]).toMatchObject({ aStart: 4, aEnd: 7, bStart: 4, bEnd: 4 });
    expect(ops[2]).toMatchObject({ aStart: 7, aEnd: 7, bStart: 4, bEnd: 7 });
  });

  it("handles edits at both ends", () => {
    const a = "alpha beta gamma";
    const b = "one alpha beta gamma two";
    const ops = diffWords(a, b);
    expectValidDiff(a, b, ops);
    expect(brief(ops)).toEqual(["+one ", "=alpha beta gamma", "+ two"]);
  });

  it("compares whole words, never parts of them", () => {
    const ops = diffWords("the category is fixed", "the catalogue is fixed");
    expect(brief(ops)).toEqual(["=the ", "-category", "+catalogue", "= is fixed"]);
  });

  it("is deterministic", () => {
    const random = rng(11);
    const a = randomText(random, 300);
    const b = mutate(random, a, 30);
    expect(diffWords(a, b)).toEqual(diffWords(a, b));
  });

  it("rejects invalid options with a typed error", () => {
    let caught: unknown;
    try {
      diffWords("a", "b", { minMoveTokens: 0 });
    } catch (error) {
      caught = error;
    }
    expect(isOfficeError(caught, "invalid_argument")).toBe(true);
  });
});

describe("diffWords: natural reading", () => {
  it("merges whitespace-only equalities between neighbouring replacements", () => {
    const ops = diffWords("I like red apples", "I love green apples");
    expect(brief(ops)).toEqual(["=I ", "-like red", "+love green", "= apples"]);
  });

  it("rewrites a phrase as one deletion and one insertion", () => {
    const ops = diffWords("The quick brown fox", "A slow red dog");
    expect(brief(ops)).toEqual(["-The quick brown fox", "+A slow red dog"]);
  });

  it("keeps real equalities between distant edits", () => {
    const a = "First we agree the price and then we sign the contract";
    const b = "First we fix the price and then we execute the contract";
    expect(brief(diffWords(a, b))).toEqual([
      "=First we ", "-agree", "+fix", "= the price and then we ", "-sign", "+execute", "= the contract",
    ]);
  });

  it("inserts a whole word with its space, starting at a word boundary", () => {
    expect(brief(diffWords("the quick fox", "the quick brown fox"))).toEqual(["=the quick ", "+brown ", "=fox"]);
    expect(brief(diffWords("the quick brown fox", "the quick fox"))).toEqual(["=the quick ", "-brown ", "=fox"]);
  });

  it("keeps the whitespace a replacement has in common", () => {
    expect(brief(diffWords("one two", "one  two"))).toEqual(["=one ", "+ ", "=two"]);
    expect(brief(diffWords("Meet on Monda at noon", "Meet on  at noon"))).toEqual(["=Meet on ", "-Monda", "= at noon"]);
    expect(brief(diffWords("a\n\nb", "a\nb"))).toEqual(["=a\n", "-\n", "=b"]);
    const ops = diffWords("end.  Next", "end.\tNext");
    expectValidDiff("end.  Next", "end.\tNext", ops);
    expect(brief(ops)).toEqual(["=end.", "-  ", "+\t", "=Next"]);
  });

  it("aligns a repeated-word insertion to the word boundary", () => {
    const ops = diffWords("we will will not", "we will will will not");
    expectValidDiff("we will will not", "we will will will not", ops);
    const inserted = ops.filter((op) => op.type === "insert");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.text).toBe("will ");
  });

  it("aligns an inserted paragraph to line breaks", () => {
    const a = "First paragraph.\nThird paragraph.";
    const b = "First paragraph.\nSecond paragraph.\nThird paragraph.";
    expect(brief(diffWords(a, b))).toEqual(["=First paragraph.\n", "+Second paragraph.\n", "=Third paragraph."]);
  });

  it("slides character edits to word boundaries", () => {
    const ops = diffWords("The cat came.", "The cat cat came.", { granularity: "char" });
    expect(brief(ops)).toEqual(["=The cat ", "+cat ", "=came."]);
  });

  it("collapses scattered character matches into one replacement", () => {
    const ops = diffWords("mouse", "sofas", { granularity: "char" });
    expect(brief(ops)).toEqual(["-mouse", "+sofas"]);
  });
});

describe("diffWords: bounds", () => {
  it("still matches the common prefix and suffix above the token budget", () => {
    const random = rng(3);
    const head = randomText(random, 50);
    const tail = randomText(random, 50);
    const a = `${head} ${"x ".repeat(40)}${tail}`;
    const b = `${head} ${"y ".repeat(40)}${tail}`;
    const ops = diffWords(a, b, { maxTokens: 10 });
    expectValidDiff(a, b, ops);
    expect(ops[0]?.type).toBe("equal");
    expect(ops.at(-1)?.type).toBe("equal");
    expect(ops.filter((op) => op.type !== "equal").map((op) => op.type)).toEqual(["delete", "insert"]);
  });

  it("falls back to whole lines above the token budget and still finds unchanged lines", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line number ${i} has some words`);
    const changed = [...lines];
    changed[5] = "a different fifth line";
    changed.splice(30, 1);
    const a = lines.join("\n");
    const b = changed.join("\n");
    const ops = diffWords(a, b, { maxTokens: 60 });
    expectValidDiff(a, b, ops);
    const equalChars = ops.filter((op) => op.type === "equal").reduce((sum, op) => sum + op.text.length, 0);
    expect(equalChars).toBeGreaterThan(a.length * 0.8);
  });

  it("diffs two unrelated 20 000 word texts within the time bound", () => {
    const random = rng(99);
    const a = Array.from({ length: 20000 }, () => `w${Math.floor(random() * 1e9)}`).join(" ");
    const b = Array.from({ length: 20000 }, () => `v${Math.floor(random() * 1e9)}`).join(" ");
    const started = performance.now();
    const ops = diffWords(a, b);
    const elapsed = performance.now() - started;
    expectValidDiff(a, b, ops);
    expect(elapsed).toBeLessThan(4000);
  });

  it("diffs a 60 000 word document with scattered edits within the time bound", () => {
    const random = rng(5);
    const paragraphs = Array.from({ length: 1500 }, () => randomText(random, 40).replace(/\n/g, " "));
    const revised = paragraphs.map((p, i) => (i % 25 === 0 ? mutate(random, p, 3).replace(/\n/g, " ") : p));
    revised.splice(700, 2);
    const a = paragraphs.join("\n");
    const b = revised.join("\n");
    const started = performance.now();
    const ops = diffWords(a, b);
    const elapsed = performance.now() - started;
    expectValidDiff(a, b, ops);
    expect(elapsed).toBeLessThan(4000);
    const equalChars = ops.filter((op) => op.type === "equal").reduce((sum, op) => sum + op.text.length, 0);
    expect(equalChars).toBeGreaterThan(a.length * 0.9);
  });

  it("handles a highly repetitive input without quadratic blow-up", () => {
    const a = "ab ".repeat(15000);
    const b = "ab ".repeat(14990) + "cd ".repeat(10);
    const started = performance.now();
    const ops = diffWords(a, b);
    expect(performance.now() - started).toBeLessThan(4000);
    expectValidDiff(a, b, ops);
  });
});

describe("diffWords: randomised invariants", () => {
  it("holds every contract invariant for seeded random edits", () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const random = rng(seed);
      const a = randomText(random, 5 + Math.floor(random() * 120));
      const b = mutate(random, a, 1 + Math.floor(random() * 12));
      for (const granularity of ["word", "char"] as const) {
        for (const detectMoves of [true, false]) {
          const ops = diffWords(a, b, { granularity, detectMoves });
          try {
            expectValidDiff(a, b, ops);
          } catch (error) {
            throw new Error(`seed ${seed} ${granularity} moves=${detectMoves}: ${String(error)}`);
          }
          if (!detectMoves) expect(ops.every((op) => op.type !== "moveFrom" && op.type !== "moveTo")).toBe(true);
        }
      }
    }
  });

  it("holds the invariants when the work budget forces the coarse path", () => {
    for (let seed = 200; seed <= 240; seed += 1) {
      const random = rng(seed);
      const a = randomText(random, 200);
      const b = mutate(random, a, 15);
      expectValidDiff(a, b, diffWords(a, b, { maxTokens: 30 }));
      expectValidDiff(a, b, diffWords(a, b, { maxTokens: 0 }));
    }
  });
});

describe("diffSequences", () => {
  it("diffs keys and reports index ranges", () => {
    const a = ["p1", "p2", "p3", "p4"];
    const b = ["p1", "p3", "new", "p4"];
    const ops = diffSequences(a, b, { detectMoves: false });
    expectValidSequenceDiff(a, b, ops);
    expect(ops).toEqual([
      { type: "equal", aStart: 0, aEnd: 1, bStart: 0, bEnd: 0 + 1, moveId: null },
      { type: "delete", aStart: 1, aEnd: 2, bStart: 1, bEnd: 1, moveId: null },
      { type: "equal", aStart: 2, aEnd: 3, bStart: 1, bEnd: 2, moveId: null },
      { type: "insert", aStart: 3, aEnd: 3, bStart: 2, bEnd: 3, moveId: null },
      { type: "equal", aStart: 3, aEnd: 4, bStart: 3, bEnd: 4, moveId: null },
    ]);
  });

  it("reports one relocated key as a move by default", () => {
    const a = ["a", "b", "c", "d", "e"];
    const b = ["b", "c", "d", "a", "e"];
    const ops = diffSequences(a, b);
    expectValidSequenceDiff(a, b, ops);
    expect(ops.map((op) => op.type)).toEqual(["moveFrom", "equal", "moveTo", "equal"]);
    expect(ops[0]?.moveId).toBe(ops[2]?.moveId);
  });

  it("holds the invariants for seeded random sequences", () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const random = rng(seed);
      const a = Array.from({ length: Math.floor(random() * 40) }, () => `k${Math.floor(random() * 12)}`);
      const b = Array.from({ length: Math.floor(random() * 40) }, () => `k${Math.floor(random() * 12)}`);
      expectValidSequenceDiff(a, b, diffSequences(a, b));
      expectValidSequenceDiff(a, b, diffSequences(a, b, { detectMoves: false, maxTokens: 5 }));
    }
  });
});
