import { cosineSimilarity } from "./embeddings.js";

export interface VectorSearchResult {
  id: string;
  content: string;
  sourceType: string;
  sourceId: string | null;
  score: number;
}

export interface VectorSearchOptions {
  limit?: number;
  minScore?: number;
  sourceType?: string;
}

export interface VectorStore {
  upsert(
    id: string,
    content: string,
    sourceType: string,
    vector: Float32Array,
    sourceId?: string,
  ): void;
  search(
    queryVector: Float32Array,
    opts?: VectorSearchOptions,
  ): VectorSearchResult[];
  deleteBySource(sourceType: string, sourceId?: string): void;
  count(): number;
}

export function createVectorStore(sqlite: any): VectorStore {
  return {
    upsert(id, content, sourceType, vector, sourceId) {
      const vectorJson = JSON.stringify(Array.from(vector));
      const now = new Date().toISOString();
      sqlite
        .prepare(
          `
        INSERT INTO embeddings (id, content, source_type, source_id, vector, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          vector = excluded.vector,
          created_at = excluded.created_at
      `,
        )
        .run(id, content, sourceType, sourceId ?? null, vectorJson, now);
    },

    search(queryVector, opts) {
      const limit = opts?.limit ?? 10;
      const minScore = opts?.minScore ?? -1;

      let rows: any[];
      if (opts?.sourceType) {
        rows = sqlite
          .prepare(
            "SELECT id, content, source_type, source_id, vector FROM embeddings WHERE source_type = ?",
          )
          .all(opts.sourceType);
      } else {
        rows = sqlite
          .prepare(
            "SELECT id, content, source_type, source_id, vector FROM embeddings",
          )
          .all();
      }

      const scored = rows.map((row: any) => {
        const stored = new Float32Array(JSON.parse(row.vector));
        const score = cosineSimilarity(queryVector, stored);
        return {
          id: row.id as string,
          content: row.content as string,
          sourceType: row.source_type as string,
          sourceId: row.source_id as string | null,
          score,
        };
      });

      return scored
        .filter((r) => r.score > minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    deleteBySource(sourceType, sourceId) {
      if (sourceId) {
        sqlite
          .prepare(
            "DELETE FROM embeddings WHERE source_type = ? AND source_id = ?",
          )
          .run(sourceType, sourceId);
      } else {
        sqlite
          .prepare("DELETE FROM embeddings WHERE source_type = ?")
          .run(sourceType);
      }
    },

    count() {
      const result = sqlite
        .prepare("SELECT count(*) as c FROM embeddings")
        .get() as { c: number };
      return result.c;
    },
  };
}
