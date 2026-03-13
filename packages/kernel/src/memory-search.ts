import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createMemoryStore } from "./memory.js";
import type { MatrixDB } from "./db.js";

export interface MemorySearchResult {
  type: "memory" | "conversation_summary";
  content: string;
  source?: string;
}

export interface MemorySearchOptions {
  query: string;
  scope?: "all" | "memories" | "conversations";
  limit?: number;
}

export function searchMemories(
  db: MatrixDB,
  homePath: string,
  opts: MemorySearchOptions,
): MemorySearchResult[] {
  const { query, scope = "all", limit = 10 } = opts;
  const results: MemorySearchResult[] = [];

  if (scope === "all" || scope === "memories") {
    if (query.trim()) {
      const memStore = createMemoryStore(db);
      const memories = memStore.recall(query, { limit });
      for (const m of memories) {
        results.push({
          type: "memory",
          content: `[${m.category}] ${m.content}`,
          source: m.source ?? undefined,
        });
      }
    }
  }

  if (scope === "all" || scope === "conversations") {
    const summariesDir = join(homePath, "system", "summaries");
    if (existsSync(summariesDir)) {
      const lowerQuery = query.toLowerCase();
      const files = readdirSync(summariesDir).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        try {
          const content = readFileSync(join(summariesDir, f), "utf-8");
          if (content.toLowerCase().includes(lowerQuery)) {
            const body = content.replace(/^---[\s\S]*?---\n*/m, "").trim();
            results.push({
              type: "conversation_summary",
              content: body,
              source: f.replace(".md", ""),
            });
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  return results.slice(0, limit);
}
