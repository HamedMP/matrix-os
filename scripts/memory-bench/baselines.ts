import { extractMemoriesLocal } from "../../packages/gateway/src/memory-extractor.js";
import { estimateTokens } from "../../packages/kernel/src/memory-evaluation/context.js";
import { LIMITS } from "../../packages/kernel/src/memory-evaluation/contracts.js";
import type { MemoryAdapter, Source, Retrieval, Admission } from "../../packages/kernel/src/memory-evaluation/contracts.js";

export type BaselineName = "none" | "raw-lexical" | "matrix-local";
export function createBaseline(name: BaselineName): MemoryAdapter {
  const sources = new Map<string, Pick<Source, "id" | "scope" | "observedAt"> & { spans: Retrieval["hits"] }>();
  const revoked = new Set<string>();
  const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return {
    metadata: { name, version: name === "matrix-local" ? "2" : "1", configuration: {
      extraction: name === "matrix-local" ? "gateway extractMemoriesLocal" : "none",
      retrieval: name === "none" ? "none" : "synthetic corpus lexical scan; not production search",
      tokenizer: "ceil(context UTF-16 length / 4)", model: "none",
    } },
    async ingest(source) {
      if (sources.size >= LIMITS.sources && !sources.has(source.id)) throw new Error("Benchmark corpus cap exceeded");
      let placements: Admission["placements"] = [];
      let spans: Retrieval["hits"] = [];
      if (name === "raw-lexical") placements = ["source"];
      if (name === "raw-lexical") spans = [{ sourceId: source.id, text: source.text, start: 0, end: source.text.length }];
      if (name === "matrix-local") {
        const candidates = extractMemoriesLocal([{ role: source.role, content: source.text }]);
        placements = candidates.map(c => c.category);
        spans = candidates.flatMap(c => {
          const start = source.text.indexOf(c.content);
          return start < 0 || !c.content ? [] : [{ sourceId: source.id, text: c.content, start, end: start + c.content.length }];
        });
      }
      if (placements.length) sources.set(source.id, { id: source.id, scope: source.scope, observedAt: source.observedAt, spans });
      return { action: placements.length ? "retain" : "skip", placements: [...new Set(placements)], telemetry: { costUsd: 0, calls: [] } };
    },
    async retrieve(query) {
      if (!query.scopes.length || name === "none") return { hits: [], status: "unknown", telemetry: { costUsd: 0 } };
      const words = [...new Set(tokens(query.text))];
      const ranked = [...sources.values()].filter((s) => query.scopes.includes(s.scope) && !revoked.has(s.scope) && Date.parse(s.observedAt) <= Date.parse(query.knownAt ?? query.at))
        .map((source) => {
          const ranked = source.spans.map(hit => ({ hit, score: words.reduce((score, word) => score + (tokens(hit.text).includes(word) ? 1 : 0), 0) }))
            .sort((a, b) => b.score - a.score || a.hit.start - b.hit.start);
          return ranked[0]; // One candidate per source keeps file-level denominators honest.
        }).filter((r): r is { hit: Retrieval["hits"][number]; score: number } => !!r && r.score > 0)
        .sort((a, b) => b.score - a.score || a.hit.sourceId.localeCompare(b.hit.sourceId));
      const hits: Retrieval["hits"] = [];
      for (const { hit } of ranked) {
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
