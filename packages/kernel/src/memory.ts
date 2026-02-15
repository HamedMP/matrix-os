import { eq } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { memories } from "./schema.js";
import type { MatrixDB } from "./db.js";

export interface MemoryEntry {
  id: string;
  content: string;
  source: string | null;
  category: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MemoryStore {
  remember(content: string, opts?: { source?: string; category?: string }): string;
  recall(query: string, opts?: { limit?: number; category?: string }): MemoryEntry[];
  forget(id: string): void;
  listAll(opts?: { category?: string; limit?: number }): MemoryEntry[];
  exportToFiles(memoryDir: string): void;
  count(): number;
}

export function createMemoryStore(db: MatrixDB): MemoryStore {
  const sqlite = (db as any).$client;

  return {
    remember(content: string, opts?: { source?: string; category?: string }): string {
      const existing = db
        .select()
        .from(memories)
        .where(eq(memories.content, content))
        .get();

      if (existing) {
        const now = new Date().toISOString();
        db.update(memories)
          .set({
            updatedAt: now,
            source: opts?.source ?? existing.source,
            category: opts?.category ?? existing.category,
          })
          .where(eq(memories.id, existing.id))
          .run();
        return existing.id;
      }

      const id = `mem-${randomUUID().slice(0, 12)}`;
      const now = new Date().toISOString();
      db.insert(memories)
        .values({
          id,
          content,
          source: opts?.source ?? null,
          category: opts?.category ?? "fact",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      sqlite.prepare("INSERT INTO memories_fts(rowid, content) VALUES ((SELECT rowid FROM memories WHERE id = ?), ?)").run(id, content);

      return id;
    },

    recall(query: string, opts?: { limit?: number; category?: string }): MemoryEntry[] {
      const limit = opts?.limit ?? 10;
      const ftsQuery = query
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => `"${w}"`)
        .join(" OR ");

      if (!ftsQuery) return [];

      let sql: string;
      const params: unknown[] = [];

      if (opts?.category) {
        sql = `
          SELECT m.id, m.content, m.source, m.category, m.created_at as createdAt, m.updated_at as updatedAt
          FROM memories m
          JOIN memories_fts f ON m.rowid = f.rowid
          WHERE memories_fts MATCH ? AND m.category = ?
          ORDER BY rank
          LIMIT ?
        `;
        params.push(ftsQuery, opts.category, limit);
      } else {
        sql = `
          SELECT m.id, m.content, m.source, m.category, m.created_at as createdAt, m.updated_at as updatedAt
          FROM memories m
          JOIN memories_fts f ON m.rowid = f.rowid
          WHERE memories_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `;
        params.push(ftsQuery, limit);
      }

      try {
        return sqlite.prepare(sql).all(...params) as MemoryEntry[];
      } catch {
        return [];
      }
    },

    forget(id: string): void {
      const existing = db.select().from(memories).where(eq(memories.id, id)).get();
      if (existing) {
        sqlite.prepare("DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)").run(id);
        db.delete(memories).where(eq(memories.id, id)).run();
      }
    },

    listAll(opts?: { category?: string; limit?: number }): MemoryEntry[] {
      let query = db.select().from(memories);

      if (opts?.category) {
        query = query.where(eq(memories.category, opts.category)) as typeof query;
      }

      if (opts?.limit) {
        query = query.limit(opts.limit) as typeof query;
      }

      return query.all();
    },

    exportToFiles(memoryDir: string): void {
      mkdirSync(memoryDir, { recursive: true });
      const all = db.select().from(memories).all();

      for (const mem of all) {
        const frontmatter = [
          "---",
          `id: ${mem.id}`,
          `category: ${mem.category ?? "fact"}`,
          ...(mem.source ? [`source: ${mem.source}`] : []),
          `created: ${mem.createdAt ?? ""}`,
          `updated: ${mem.updatedAt ?? ""}`,
          "---",
          "",
          mem.content,
          "",
        ].join("\n");

        const fileName = `${mem.category ?? "fact"}-${mem.id.slice(4, 12)}.md`;
        writeFileSync(join(memoryDir, fileName), frontmatter);
      }
    },

    count(): number {
      const result = sqlite.prepare("SELECT count(*) as c FROM memories").get() as { c: number };
      return result.c;
    },
  };
}

export interface ConversationMessage {
  role: string;
  content: string;
}

export interface MemoryCandidate {
  content: string;
  category: string;
}

const EXTRACT_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /(?:i prefer|i always want|i like|my preference is)\s+(.+)/i, category: "preference" },
  { pattern: /(?:my name is|i am called|call me)\s+(.+)/i, category: "fact" },
  { pattern: /(?:i live in|i'm from|i'm based in)\s+(.+)/i, category: "fact" },
  { pattern: /(?:remember that|don't forget|keep in mind)\s+(.+)/i, category: "instruction" },
  { pattern: /(?:i work as|my job is|i'm a|my role is)\s+(.+)/i, category: "fact" },
  { pattern: /(?:my timezone is|i'm in)\s+(\w+(?:\s+timezone)?)/i, category: "fact" },
  { pattern: /(?:always|never)\s+(.+)/i, category: "instruction" },
];

export function extractMemories(conversation: ConversationMessage[]): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];

  for (const msg of conversation) {
    if (msg.role !== "user") continue;

    for (const { pattern, category } of EXTRACT_PATTERNS) {
      const match = msg.content.match(pattern);
      if (match?.[1]) {
        candidates.push({
          content: match[1].trim().replace(/[.!?]$/, ""),
          category,
        });
      }
    }
  }

  return candidates;
}
