import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createVectorStore, type VectorStore } from "../../packages/kernel/src/vector-store.js";
import Database from "better-sqlite3";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE embeddings (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      vector TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_embeddings_source ON embeddings(source_type, source_id);
  `);
  return db;
}

describe("vector store", () => {
  let db: InstanceType<typeof Database>;
  let store: VectorStore;

  beforeEach(() => {
    db = createTestDb();
    store = createVectorStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("upsert", () => {
    it("stores a vector entry", () => {
      const vector = new Float32Array([1, 0, 0, 0]);
      store.upsert("test-1", "hello world", "memory", vector);
      expect(store.count()).toBe(1);
    });

    it("updates existing entry on same id", () => {
      store.upsert("id-1", "old content", "memory", new Float32Array([1, 0]));
      store.upsert("id-1", "new content", "memory", new Float32Array([0, 1]));
      expect(store.count()).toBe(1);

      const results = store.search(new Float32Array([0, 1]), { limit: 10 });
      expect(results.length).toBe(1);
      expect(results[0].content).toBe("new content");
    });

    it("stores optional sourceId", () => {
      store.upsert("id-1", "content", "conversation", new Float32Array([1, 0]), "session-123");
      const results = store.search(new Float32Array([1, 0]), { limit: 1 });
      expect(results[0].sourceId).toBe("session-123");
    });

    it("handles null sourceId", () => {
      store.upsert("id-1", "content", "memory", new Float32Array([1, 0]));
      const results = store.search(new Float32Array([1, 0]), { limit: 1 });
      expect(results[0].sourceId).toBeNull();
    });
  });

  describe("search", () => {
    it("retrieves stored vectors with similarity score", () => {
      const vector = new Float32Array([1, 0, 0, 0]);
      store.upsert("test-1", "hello world", "memory", vector);

      const results = store.search(new Float32Array([1, 0, 0, 0]), { limit: 5 });
      expect(results.length).toBe(1);
      expect(results[0].content).toBe("hello world");
      expect(results[0].score).toBeCloseTo(1.0, 3);
    });

    it("ranks by cosine similarity", () => {
      store.upsert("a", "exact match", "memory", new Float32Array([1, 0, 0, 0]));
      store.upsert("b", "partial match", "memory", new Float32Array([0.7, 0.7, 0, 0]));
      store.upsert("c", "no match", "memory", new Float32Array([0, 0, 0, 1]));

      const results = store.search(new Float32Array([1, 0, 0, 0]), { limit: 3 });
      expect(results[0].content).toBe("exact match");
      expect(results[1].content).toBe("partial match");
      expect(results[2].content).toBe("no match");
    });

    it("filters by source type", () => {
      store.upsert("mem-1", "memory content", "memory", new Float32Array([1, 0]));
      store.upsert("conv-1", "conversation content", "conversation", new Float32Array([1, 0]));

      const results = store.search(new Float32Array([1, 0]), { sourceType: "memory" });
      expect(results.length).toBe(1);
      expect(results[0].sourceType).toBe("memory");
    });

    it("respects minimum score threshold", () => {
      store.upsert("good", "relevant", "memory", new Float32Array([1, 0]));
      store.upsert("bad", "irrelevant", "memory", new Float32Array([0, 1]));

      const results = store.search(new Float32Array([1, 0]), { minScore: 0.5 });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("good");
    });

    it("respects limit", () => {
      for (let i = 0; i < 20; i++) {
        store.upsert(`item-${i}`, `content ${i}`, "memory", new Float32Array([1, 0]));
      }
      const results = store.search(new Float32Array([1, 0]), { limit: 5 });
      expect(results.length).toBe(5);
    });

    it("defaults to limit of 10", () => {
      for (let i = 0; i < 15; i++) {
        store.upsert(`item-${i}`, `content ${i}`, "memory", new Float32Array([1, 0]));
      }
      const results = store.search(new Float32Array([1, 0]));
      expect(results.length).toBe(10);
    });

    it("returns results with all expected fields", () => {
      store.upsert("id-1", "some content", "memory", new Float32Array([1, 0]), "src-1");
      const results = store.search(new Float32Array([1, 0]), { limit: 1 });
      expect(results[0]).toEqual({
        id: "id-1",
        content: "some content",
        sourceType: "memory",
        sourceId: "src-1",
        score: expect.any(Number),
      });
    });

    it("returns empty array when no data", () => {
      const results = store.search(new Float32Array([1, 0]), { limit: 5 });
      expect(results).toEqual([]);
    });
  });

  describe("deleteBySource", () => {
    it("deletes all entries of a source type", () => {
      store.upsert("a", "content a", "conversation", new Float32Array([1, 0]));
      store.upsert("b", "content b", "conversation", new Float32Array([0, 1]));
      store.upsert("c", "content c", "memory", new Float32Array([1, 1]));

      store.deleteBySource("conversation");
      expect(store.count()).toBe(1);

      const results = store.search(new Float32Array([1, 1]), { limit: 10 });
      expect(results.length).toBe(1);
      expect(results[0].sourceType).toBe("memory");
    });

    it("deletes entries by source type and source id", () => {
      store.upsert("a", "content a", "conversation", new Float32Array([1, 0]), "s1");
      store.upsert("b", "content b", "conversation", new Float32Array([0, 1]), "s2");

      store.deleteBySource("conversation", "s1");
      expect(store.count()).toBe(1);
    });

    it("does nothing when no entries match", () => {
      store.upsert("a", "content a", "memory", new Float32Array([1, 0]));
      store.deleteBySource("conversation");
      expect(store.count()).toBe(1);
    });
  });

  describe("count", () => {
    it("returns 0 for empty store", () => {
      expect(store.count()).toBe(0);
    });

    it("returns correct count after inserts", () => {
      store.upsert("a", "content a", "memory", new Float32Array([1, 0]));
      store.upsert("b", "content b", "memory", new Float32Array([0, 1]));
      expect(store.count()).toBe(2);
    });

    it("decrements after delete", () => {
      store.upsert("a", "content a", "memory", new Float32Array([1, 0]));
      store.upsert("b", "content b", "memory", new Float32Array([0, 1]));
      store.deleteBySource("memory");
      expect(store.count()).toBe(0);
    });
  });
});
