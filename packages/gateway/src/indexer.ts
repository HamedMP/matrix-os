export interface IndexerDeps {
  embed: (text: string) => Promise<Float32Array>;
  upsert: (
    id: string,
    content: string,
    sourceType: string,
    vector: Float32Array,
    sourceId?: string,
  ) => void;
}

export interface Indexer {
  index(
    id: string,
    content: string,
    sourceType: string,
    sourceId?: string,
  ): Promise<void>;
  indexBatch(
    items: Array<{
      id: string;
      content: string;
      sourceType: string;
      sourceId?: string;
    }>,
  ): Promise<void>;
}

export function createIndexer(deps: IndexerDeps): Indexer {
  return {
    async index(id, content, sourceType, sourceId) {
      if (!content.trim()) return;
      try {
        const vector = await deps.embed(content);
        deps.upsert(id, content, sourceType, vector, sourceId);
      } catch {
        // Embedding failed, skip silently
      }
    },

    async indexBatch(items) {
      for (const item of items) {
        await this.index(item.id, item.content, item.sourceType, item.sourceId);
      }
    },
  };
}
