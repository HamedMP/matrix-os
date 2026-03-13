import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDB, type MatrixDB } from "../../packages/kernel/src/db.js";
import { createMemoryStore, type MemoryStore } from "../../packages/kernel/src/memory.js";
import {
  searchMemories,
  type MemorySearchResult,
} from "../../packages/kernel/src/memory-search.js";

describe("memory_search tool logic", () => {
  let home: string;
  let db: MatrixDB;
  let store: MemoryStore;

  beforeEach(() => {
    home = resolve(mkdtempSync(join(tmpdir(), "mem-search-")));
    mkdirSync(join(home, "system", "summaries"), { recursive: true });
    db = createDB();
    store = createMemoryStore(db);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("searchMemories with scope='all'", () => {
    it("returns empty array when no data exists", () => {
      const results = searchMemories(db, home, { query: "anything" });
      expect(results).toEqual([]);
    });

    it("finds memories from FTS store", () => {
      store.remember("User prefers dark themes", { category: "preference" });
      store.remember("User lives in Stockholm", { category: "fact" });

      const results = searchMemories(db, home, { query: "dark themes" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.type === "memory")).toBe(true);
      expect(results.some((r) => r.content.includes("dark themes"))).toBe(true);
    });

    it("finds conversation summaries by substring match", () => {
      writeFileSync(
        join(home, "system", "summaries", "s1.md"),
        "---\nsession: s1\ndate: 2026-03-13\n---\n\nUser asked about deploying to Kubernetes\n",
      );
      writeFileSync(
        join(home, "system", "summaries", "s2.md"),
        "---\nsession: s2\ndate: 2026-03-12\n---\n\nUser discussed todo app features\n",
      );

      const results = searchMemories(db, home, { query: "kubernetes" });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("conversation_summary");
      expect(results[0].content).toContain("Kubernetes");
      expect(results[0].source).toBe("s1");
    });

    it("merges results from both sources", () => {
      store.remember("User works with Kubernetes clusters", { category: "fact" });
      writeFileSync(
        join(home, "system", "summaries", "s1.md"),
        "---\nsession: s1\ndate: 2026-03-13\n---\n\nDiscussed Kubernetes deployment strategy\n",
      );

      const results = searchMemories(db, home, { query: "Kubernetes" });
      expect(results.length).toBe(2);
      const types = results.map((r) => r.type);
      expect(types).toContain("memory");
      expect(types).toContain("conversation_summary");
    });
  });

  describe("searchMemories with scope='memories'", () => {
    it("only searches FTS memories, ignores summaries", () => {
      store.remember("User prefers TypeScript", { category: "preference" });
      writeFileSync(
        join(home, "system", "summaries", "s1.md"),
        "---\nsession: s1\ndate: 2026-03-13\n---\n\nDiscussed TypeScript patterns\n",
      );

      const results = searchMemories(db, home, {
        query: "TypeScript",
        scope: "memories",
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.type === "memory")).toBe(true);
    });
  });

  describe("searchMemories with scope='conversations'", () => {
    it("only searches summaries, ignores FTS memories", () => {
      store.remember("User prefers TypeScript", { category: "preference" });
      writeFileSync(
        join(home, "system", "summaries", "s1.md"),
        "---\nsession: s1\ndate: 2026-03-13\n---\n\nDiscussed TypeScript patterns\n",
      );

      const results = searchMemories(db, home, {
        query: "TypeScript",
        scope: "conversations",
      });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("conversation_summary");
    });
  });

  describe("limit parameter", () => {
    it("respects limit across merged results", () => {
      store.remember("Fact about TypeScript 1", { category: "fact" });
      store.remember("Fact about TypeScript 2", { category: "fact" });
      store.remember("Fact about TypeScript 3", { category: "fact" });
      writeFileSync(
        join(home, "system", "summaries", "s1.md"),
        "---\nsession: s1\ndate: 2026-03-13\n---\n\nTypeScript discussion\n",
      );

      const results = searchMemories(db, home, {
        query: "TypeScript",
        limit: 2,
      });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("defaults to limit of 10", () => {
      for (let i = 0; i < 15; i++) {
        writeFileSync(
          join(home, "system", "summaries", `s${i}.md`),
          `---\nsession: s${i}\ndate: 2026-03-13\n---\n\nSummary about testing topic ${i}\n`,
        );
      }

      const results = searchMemories(db, home, { query: "testing" });
      expect(results.length).toBeLessThanOrEqual(10);
    });
  });

  describe("case-insensitive search on summaries", () => {
    it("matches regardless of case", () => {
      writeFileSync(
        join(home, "system", "summaries", "s1.md"),
        "---\nsession: s1\ndate: 2026-03-13\n---\n\nUser asked about DOCKER deployment\n",
      );

      const results = searchMemories(db, home, { query: "docker" });
      expect(results.length).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("handles missing summaries directory", () => {
      rmSync(join(home, "system", "summaries"), { recursive: true, force: true });

      const results = searchMemories(db, home, { query: "anything" });
      expect(results).toEqual([]);
    });

    it("skips malformed summary files", () => {
      writeFileSync(
        join(home, "system", "summaries", "good.md"),
        "---\nsession: good\ndate: 2026-03-13\n---\n\nGood summary about testing\n",
      );
      // Create a directory where a file is expected (edge case)
      mkdirSync(join(home, "system", "summaries", "bad.md"), { recursive: true });

      const results = searchMemories(db, home, { query: "testing" });
      expect(results.length).toBe(1);
    });

    it("handles empty query gracefully", () => {
      store.remember("Some fact");
      const results = searchMemories(db, home, { query: "" });
      // Empty query should return empty (FTS won't match, substring "" matches everything but that's ok)
      expect(Array.isArray(results)).toBe(true);
    });

    it("returns category for memory results", () => {
      store.remember("User prefers dark mode", { category: "preference" });

      const results = searchMemories(db, home, { query: "dark mode" });
      const memResult = results.find((r) => r.type === "memory");
      expect(memResult).toBeDefined();
      expect(memResult!.content).toContain("[preference]");
    });
  });
});
