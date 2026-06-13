import { describe, expect, it } from "vitest";
import { fuzzyScore, rankFiles } from "@desktop/renderer/src/lib/quick-open";

describe("fuzzyScore", () => {
  it("requires the query to be a subsequence of the candidate", () => {
    expect(fuzzyScore("xyz", "src/chat.ts")).toBe(0);
    expect(fuzzyScore("tac", "chat.ts")).toBe(0);
    expect(fuzzyScore("cht", "chat.ts")).toBeGreaterThan(0);
  });

  it("returns 0 for empty query, empty candidate, or query longer than candidate", () => {
    expect(fuzzyScore("", "chat.ts")).toBe(0);
    expect(fuzzyScore("chat", "")).toBe(0);
    expect(fuzzyScore("chat.ts.long", "chat.ts")).toBe(0);
  });

  it("matches case-insensitively", () => {
    expect(fuzzyScore("readme", "README.md")).toBeGreaterThan(0);
  });

  it("gives a bonus for exact-case matches", () => {
    expect(fuzzyScore("README", "README.md")).toBeGreaterThan(fuzzyScore("readme", "README.md"));
  });

  it("scores consecutive runs above scattered matches", () => {
    expect(fuzzyScore("cha", "chat.ts")).toBeGreaterThan(fuzzyScore("cha", "cxhxa.ts"));
  });

  it("scores segment starts above embedded matches", () => {
    expect(fuzzyScore("kb", "kernel-bridge.ts")).toBeGreaterThan(fuzzyScore("kb", "skb.ts"));
  });

  it("prefers a basename alignment over an earlier directory alignment", () => {
    // "ab" aligns fully inside the basename of abx/ab.ts; the greedy full-path
    // walk alone would have consumed the directory "abx" first.
    expect(fuzzyScore("ab", "abx/ab.ts")).toBeGreaterThan(fuzzyScore("ab", "abq/x.ts"));
  });
});

describe("rankFiles", () => {
  it("ranks basename matches above directory matches", () => {
    const hits = rankFiles("chat", ["src/chat/util.ts", "src/lib/chat.ts"]);
    expect(hits.map((h) => h.path)).toEqual(["src/lib/chat.ts", "src/chat/util.ts"]);
  });

  it("extracts the basename as the hit name", () => {
    const hits = rankFiles("chat", ["src/lib/chat.ts", "chatter"]);
    expect(hits[0]).toEqual({ path: "src/lib/chat.ts", name: "chat.ts" });
    expect(hits.find((h) => h.path === "chatter")).toEqual({ path: "chatter", name: "chatter" });
  });

  it("excludes paths that do not match", () => {
    const hits = rankFiles("chat", ["src/board.ts", "src/chat.ts"]);
    expect(hits.map((h) => h.path)).toEqual(["src/chat.ts"]);
  });

  it("bounds results to the default limit of 50", () => {
    const paths = Array.from({ length: 80 }, (_, i) => `src/chat-${i}.ts`);
    expect(rankFiles("chat", paths)).toHaveLength(50);
  });

  it("honors an explicit limit", () => {
    const paths = Array.from({ length: 80 }, (_, i) => `src/chat-${i}.ts`);
    expect(rankFiles("chat", paths, 10)).toHaveLength(10);
    expect(rankFiles("chat", paths, 0)).toHaveLength(0);
  });

  it("returns the first limit paths as-is for an empty query", () => {
    const paths = ["b/second.ts", "a/first.ts", "c/third.ts"];
    expect(rankFiles("", paths, 2)).toEqual([
      { path: "b/second.ts", name: "second.ts" },
      { path: "a/first.ts", name: "first.ts" },
    ]);
  });

  it("breaks score ties by path ascending", () => {
    const hits = rankFiles("chat", ["b/chat.ts", "a/chat.ts"]);
    expect(hits.map((h) => h.path)).toEqual(["a/chat.ts", "b/chat.ts"]);
  });

  it("ranks 10k paths well under 500ms", () => {
    const paths = Array.from(
      { length: 10_000 },
      (_, i) => `packages/pkg-${i % 40}/src/module-${i % 200}/feature-file-${i}.ts`,
    );
    const start = performance.now();
    const hits = rankFiles("featfile", paths);
    const elapsed = performance.now() - start;
    expect(hits).toHaveLength(50);
    expect(elapsed).toBeLessThan(500);
  });
});
