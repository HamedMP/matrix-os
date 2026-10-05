import { extractMemoriesLocal } from "../../packages/gateway/src/memory-extractor.js";
import { estimateTokens } from "../../packages/kernel/src/memory-evaluation/context.js";
import { LIMITS } from "../../packages/kernel/src/memory-evaluation/contracts.js";
import type { MemoryAdapter, Source, Retrieval, Admission } from "../../packages/kernel/src/memory-evaluation/contracts.js";

export type BaselineName = "none" | "raw-lexical" | "matrix-local";
export function createBaseline(name: BaselineName): MemoryAdapter {
  const sources = new Map<string, Source>();
  const revoked = new Set<string>();
  const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return {
    metadata: { name, version: "1", configuration: {
      extraction: name === "matrix-local" ? "gateway extractMemoriesLocal" : "none",
      retrieval: name === "none" ? "none" : "synthetic corpus lexical scan; not production search",
      tokenizer: "ceil(context UTF-16 length / 4)", model: "none",
    } },
    async ingest(source) {
      if (sources.size >= LIMITS.sources && !sources.has(source.id)) throw new Error("Benchmark corpus cap exceeded");
      let placements: Admission["placements"] = [];
      if (name === "raw-lexical") placements = ["source"];
      if (name === "matrix-local") placements = extractMemoriesLocal([{ role: source.role, content: source.text }]).map((c) => c.category);
      if (placements.length) sources.set(source.id, structuredClone(source));
      return { action: placements.length ? "retain" : "skip", placements: [...new Set(placements)], telemetry: { costUsd: 0, calls: [] } };
    },
    async retrieve(query) {
      if (!query.scopes.length || name === "none") return { hits: [], status: "unknown", telemetry: { costUsd: 0 } };
      const words = [...new Set(tokens(query.text))];
      const ranked = [...sources.values()].filter((s) => query.scopes.includes(s.scope) && !revoked.has(s.scope) && Date.parse(s.observedAt) <= Date.parse(query.knownAt ?? query.at))
        .map((source) => ({ source, score: words.reduce((s, w) => s + (tokens(source.text).includes(w) ? 1 : 0), 0) }))
        .filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id));
      const hits: Retrieval["hits"] = [];
      for (const { source } of ranked) {
        const hit = { sourceId: source.id, text: source.text, start: 0, end: source.text.length };
        if (estimateTokens([...hits, hit]) <= query.budgetTokens) hits.push(hit);
        if (hits.length >= query.limit) break;
      }
      return { hits, status: hits.length ? "evidence" : "unknown", telemetry: { costUsd: 0 } };
    },
    async forget(sourceId) { sources.delete(sourceId); return { telemetry: { costUsd: 0 } }; },
    async revoke(scope) {
      if (revoked.size >= 50 && !revoked.has(scope)) throw new Error("Benchmark scope cap exceeded");
      revoked.add(scope);
      return { telemetry: { costUsd: 0 } };
    },
    async close() { sources.clear(); revoked.clear(); },
  };
}
