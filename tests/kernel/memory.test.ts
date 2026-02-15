import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDB, type MatrixDB } from "../../packages/kernel/src/db.js";
import { createMemoryStore, extractMemories, type MemoryStore } from "../../packages/kernel/src/memory.js";

describe("Memory Store", () => {
  let db: MatrixDB;
  let store: MemoryStore;

  beforeEach(() => {
    db = createDB();
    store = createMemoryStore(db);
  });

  describe("createMemoryStore", () => {
    it("initializes without error", () => {
      expect(store).toBeDefined();
      expect(typeof store.remember).toBe("function");
      expect(typeof store.recall).toBe("function");
      expect(typeof store.forget).toBe("function");
      expect(typeof store.listAll).toBe("function");
      expect(typeof store.exportToFiles).toBe("function");
      expect(typeof store.count).toBe("function");
    });

    it("starts with zero memories", () => {
      expect(store.count()).toBe(0);
    });
  });

  describe("remember", () => {
    it("inserts a memory entry and returns its id", () => {
      const id = store.remember("User prefers dark themes");
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("stores content with default category 'fact'", () => {
      store.remember("User lives in Stockholm");
      const all = store.listAll();
      expect(all).toHaveLength(1);
      expect(all[0].content).toBe("User lives in Stockholm");
      expect(all[0].category).toBe("fact");
    });

    it("accepts optional source and category", () => {
      store.remember("Prefers TypeScript over JavaScript", {
        source: "conversation-123",
        category: "preference",
      });
      const all = store.listAll();
      expect(all).toHaveLength(1);
      expect(all[0].source).toBe("conversation-123");
      expect(all[0].category).toBe("preference");
    });

    it("increments count after each insert", () => {
      store.remember("fact 1");
      store.remember("fact 2");
      store.remember("fact 3");
      expect(store.count()).toBe(3);
    });
  });

  describe("recall", () => {
    beforeEach(() => {
      store.remember("User prefers dark themes", { category: "preference" });
      store.remember("User lives in Stockholm, Sweden", { category: "fact" });
      store.remember("User works as a software engineer", { category: "fact" });
      store.remember("Always use TypeScript strict mode", { category: "instruction" });
    });

    it("returns relevant memories ranked by FTS5 score", () => {
      const results = store.recall("dark themes");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("dark themes");
    });

    it("returns empty array when no matches", () => {
      const results = store.recall("quantum physics");
      expect(results).toEqual([]);
    });

    it("respects limit parameter", () => {
      const results = store.recall("user", { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("filters by category", () => {
      const results = store.recall("user", { category: "preference" });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.category).toBe("preference");
      }
    });

    it("returns results with id, content, source, category, createdAt", () => {
      const results = store.recall("Stockholm");
      expect(results.length).toBeGreaterThan(0);
      const mem = results[0];
      expect(mem.id).toBeDefined();
      expect(mem.content).toBeDefined();
      expect(mem.category).toBeDefined();
      expect(mem.createdAt).toBeDefined();
    });
  });

  describe("forget", () => {
    it("removes a memory entry by id", () => {
      const id = store.remember("temporary fact");
      expect(store.count()).toBe(1);
      store.forget(id);
      expect(store.count()).toBe(0);
    });

    it("does not throw when forgetting non-existent id", () => {
      expect(() => store.forget("nonexistent")).not.toThrow();
    });

    it("only removes the specified memory", () => {
      const id1 = store.remember("fact 1");
      store.remember("fact 2");
      store.forget(id1);
      expect(store.count()).toBe(1);
      const all = store.listAll();
      expect(all[0].content).toBe("fact 2");
    });
  });

  describe("listAll", () => {
    it("returns empty array when no memories", () => {
      expect(store.listAll()).toEqual([]);
    });

    it("returns all stored memories", () => {
      store.remember("fact 1");
      store.remember("fact 2");
      store.remember("fact 3");
      expect(store.listAll()).toHaveLength(3);
    });

    it("filters by category", () => {
      store.remember("pref 1", { category: "preference" });
      store.remember("fact 1", { category: "fact" });
      store.remember("pref 2", { category: "preference" });

      const prefs = store.listAll({ category: "preference" });
      expect(prefs).toHaveLength(2);
      for (const p of prefs) {
        expect(p.category).toBe("preference");
      }
    });

    it("respects limit", () => {
      store.remember("fact 1");
      store.remember("fact 2");
      store.remember("fact 3");
      const limited = store.listAll({ limit: 2 });
      expect(limited).toHaveLength(2);
    });
  });

  describe("duplicate detection", () => {
    it("updates instead of duplicating when same content is remembered", () => {
      store.remember("User prefers dark themes", { category: "preference" });
      store.remember("User prefers dark themes", { category: "preference" });
      expect(store.count()).toBe(1);
    });

    it("updates the updatedAt timestamp on duplicate", () => {
      const id1 = store.remember("User prefers dark themes");
      const before = store.listAll()[0].updatedAt;
      const id2 = store.remember("User prefers dark themes");
      const after = store.listAll()[0].updatedAt;
      expect(id1).toBe(id2);
      expect(after).toBeDefined();
    });

    it("treats different content as separate entries", () => {
      store.remember("User prefers dark themes");
      store.remember("User prefers light themes");
      expect(store.count()).toBe(2);
    });
  });

  describe("exportToFiles", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = resolve(mkdtempSync(join(tmpdir(), "memory-export-")));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("writes each memory as a .md file", () => {
      store.remember("User prefers dark themes", { category: "preference" });
      store.remember("User lives in Stockholm", { category: "fact" });
      store.exportToFiles(tempDir);

      const files = readdirSync(tempDir).filter((f) => f.endsWith(".md"));
      expect(files).toHaveLength(2);
    });

    it("includes frontmatter with category and dates", () => {
      store.remember("User prefers dark themes", {
        category: "preference",
        source: "conv-1",
      });
      store.exportToFiles(tempDir);

      const files = readdirSync(tempDir).filter((f) => f.endsWith(".md"));
      const content = readFileSync(join(tempDir, files[0]), "utf-8");
      expect(content).toContain("---");
      expect(content).toContain("category: preference");
      expect(content).toContain("source: conv-1");
      expect(content).toContain("User prefers dark themes");
    });

    it("creates the directory if it does not exist", () => {
      const nestedDir = join(tempDir, "nested", "memory");
      store.remember("a fact");
      store.exportToFiles(nestedDir);
      expect(existsSync(nestedDir)).toBe(true);
    });
  });
});

describe("extractMemories", () => {
  it("extracts preferences from user messages", () => {
    const results = extractMemories([
      { role: "user", content: "I prefer dark themes for my editor" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe("preference");
    expect(results[0].content).toContain("dark themes");
  });

  it("extracts facts about the user", () => {
    const results = extractMemories([
      { role: "user", content: "I live in Stockholm, Sweden" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe("fact");
    expect(results[0].content).toContain("Stockholm");
  });

  it("extracts instructions", () => {
    const results = extractMemories([
      { role: "user", content: "Remember that I use TypeScript strict mode" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe("instruction");
  });

  it("ignores assistant messages", () => {
    const results = extractMemories([
      { role: "assistant", content: "I prefer to use TypeScript" },
    ]);
    expect(results).toHaveLength(0);
  });

  it("extracts multiple memories from a conversation", () => {
    const results = extractMemories([
      { role: "user", content: "My name is Hamed" },
      { role: "assistant", content: "Nice to meet you!" },
      { role: "user", content: "I prefer dark themes" },
    ]);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for no matches", () => {
    const results = extractMemories([
      { role: "user", content: "What is the weather today?" },
    ]);
    expect(results).toHaveLength(0);
  });
});
