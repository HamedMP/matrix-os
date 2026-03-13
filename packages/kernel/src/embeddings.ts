import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface EmbeddingService {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions: number;
}

export interface EmbeddingConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function createEmbeddingService(config: EmbeddingConfig): EmbeddingService {
  if (!config.apiKey) throw new Error("Embedding API key required");

  const model = config.model ?? "text-embedding-3-small";
  const dimensions = config.dimensions ?? 256;
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  const fetchImpl = config.fetchFn ?? fetch;

  async function callApi(input: string[]): Promise<Float32Array[]> {
    const res = await fetchImpl(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model, input, dimensions }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`Embedding API error: ${res.status} ${err}`);
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return json.data.map((d) => new Float32Array(d.embedding));
  }

  return {
    dimensions,
    async embed(text: string): Promise<Float32Array> {
      const [result] = await callApi([text]);
      return result;
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      return callApi(texts);
    },
  };
}

export function loadEmbeddingConfig(homePath: string): EmbeddingConfig | null {
  const configPath = join(homePath, "system", "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.tools?.embeddings?.openai_key) {
        return { apiKey: config.tools.embeddings.openai_key };
      }
    } catch {
      /* ignore malformed config */
    }
  }
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) return { apiKey: envKey };
  return null;
}
