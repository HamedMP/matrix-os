import { describe, it, expect, vi } from "vitest";
import { createIndexer, type Indexer } from "../../packages/gateway/src/indexer.js";

describe("indexer", () => {
  describe("index", () => {
    it("indexes text content with embedding service", async () => {
      const fakeEmbed = vi.fn().mockResolvedValue(new Float32Array([1, 0, 0]));
      const fakeUpsert = vi.fn();

      const indexer = createIndexer({
        embed: fakeEmbed,
        upsert: fakeUpsert,
      });

      await indexer.index("conv-1", "User asked about todos", "conversation", "session-123");

      expect(fakeEmbed).toHaveBeenCalledWith("User asked about todos");
      expect(fakeUpsert).toHaveBeenCalledWith(
        "conv-1",
        "User asked about todos",
        "conversation",
        expect.any(Float32Array),
        "session-123",
      );
    });

    it("handles embedding errors gracefully", async () => {
      const fakeEmbed = vi.fn().mockRejectedValue(new Error("API error"));
      const fakeUpsert = vi.fn();

      const indexer = createIndexer({ embed: fakeEmbed, upsert: fakeUpsert });
      await indexer.index("id", "content", "memory");
      expect(fakeUpsert).not.toHaveBeenCalled();
    });

    it("skips empty content", async () => {
      const fakeEmbed = vi.fn();
      const fakeUpsert = vi.fn();

      const indexer = createIndexer({ embed: fakeEmbed, upsert: fakeUpsert });
      await indexer.index("id", "", "memory");
      expect(fakeEmbed).not.toHaveBeenCalled();
    });

    it("skips whitespace-only content", async () => {
      const fakeEmbed = vi.fn();
      const fakeUpsert = vi.fn();

      const indexer = createIndexer({ embed: fakeEmbed, upsert: fakeUpsert });
      await indexer.index("id", "   \n\t  ", "memory");
      expect(fakeEmbed).not.toHaveBeenCalled();
    });

    it("works without sourceId", async () => {
      const fakeEmbed = vi.fn().mockResolvedValue(new Float32Array([1, 0]));
      const fakeUpsert = vi.fn();

      const indexer = createIndexer({ embed: fakeEmbed, upsert: fakeUpsert });
      await indexer.index("id", "some content", "memory");

      expect(fakeUpsert).toHaveBeenCalledWith(
        "id",
        "some content",
        "memory",
        expect.any(Float32Array),
        undefined,
      );
    });
  });

  describe("indexBatch", () => {
    it("indexes multiple items", async () => {
      const fakeEmbed = vi.fn().mockResolvedValue(new Float32Array([1, 0]));
      const fakeUpsert = vi.fn();

      const indexer = createIndexer({ embed: fakeEmbed, upsert: fakeUpsert });
      await indexer.indexBatch([
        { id: "a", content: "content a", sourceType: "memory" },
        { id: "b", content: "content b", sourceType: "conversation", sourceId: "s1" },
      ]);

      expect(fakeEmbed).toHaveBeenCalledTimes(2);
      expect(fakeUpsert).toHaveBeenCalledTimes(2);
    });

    it("handles empty batch", async () => {
      const fakeEmbed = vi.fn();
      const fakeUpsert = vi.fn();

      const indexer = createIndexer({ embed: fakeEmbed, upsert: fakeUpsert });
      await indexer.indexBatch([]);

      expect(fakeEmbed).not.toHaveBeenCalled();
    });

    it("continues after individual item failure", async () => {
      let callCount = 0;
      const fakeEmbed = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error("fail"));
        return Promise.resolve(new Float32Array([1, 0]));
      });
      const fakeUpsert = vi.fn();

      const indexer = createIndexer({ embed: fakeEmbed, upsert: fakeUpsert });
      await indexer.indexBatch([
        { id: "a", content: "will fail", sourceType: "memory" },
        { id: "b", content: "will succeed", sourceType: "memory" },
      ]);

      expect(fakeEmbed).toHaveBeenCalledTimes(2);
      expect(fakeUpsert).toHaveBeenCalledTimes(1);
    });

    it("skips empty content items in batch", async () => {
      const fakeEmbed = vi.fn().mockResolvedValue(new Float32Array([1, 0]));
      const fakeUpsert = vi.fn();

      const indexer = createIndexer({ embed: fakeEmbed, upsert: fakeUpsert });
      await indexer.indexBatch([
        { id: "a", content: "", sourceType: "memory" },
        { id: "b", content: "real content", sourceType: "memory" },
      ]);

      expect(fakeEmbed).toHaveBeenCalledTimes(1);
      expect(fakeUpsert).toHaveBeenCalledTimes(1);
    });
  });
});
