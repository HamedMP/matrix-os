import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ConversationFile {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
}

export interface ConversationMeta {
  id: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SearchResult {
  sessionId: string;
  messageIndex: number;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  preview: string;
}

export interface ConversationStore {
  begin(sessionId: string): void;
  addUserMessage(sessionId: string, content: string): void;
  appendAssistantText(sessionId: string, text: string): void;
  finalize(sessionId: string): void;
  list(): ConversationMeta[];
  get(id: string): ConversationFile | null;
  create(channel?: string): string;
  delete(id: string): boolean;
  search(query: string, opts?: { limit?: number }): SearchResult[];
}

export function createConversationStore(homePath: string): ConversationStore {
  const dir = join(homePath, "system", "conversations");
  mkdirSync(dir, { recursive: true });
  const active = new Map<string, ConversationFile>();
  const buffers = new Map<string, string>();

  function filePath(id: string) {
    return join(dir, `${id}.json`);
  }

  function writeToDisk(conv: ConversationFile) {
    writeFileSync(filePath(conv.id), JSON.stringify(conv, null, 2));
  }

  function readFromDisk(id: string): ConversationFile | null {
    const path = filePath(id);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as ConversationFile;
  }

  return {
    begin(sessionId) {
      const existing = readFromDisk(sessionId);
      if (existing) {
        active.set(sessionId, existing);
        return;
      }

      const now = Date.now();
      const conv: ConversationFile = {
        id: sessionId,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      active.set(sessionId, conv);
    },

    addUserMessage(sessionId, content) {
      const conv = active.get(sessionId);
      if (!conv) return;

      conv.messages.push({ role: "user", content, timestamp: Date.now() });
      conv.updatedAt = Date.now();
      writeToDisk(conv);
    },

    appendAssistantText(sessionId, text) {
      const current = buffers.get(sessionId) ?? "";
      buffers.set(sessionId, current + text);
    },

    finalize(sessionId) {
      const conv = active.get(sessionId);
      if (!conv) return;

      const buffered = buffers.get(sessionId);
      if (buffered) {
        conv.messages.push({
          role: "assistant",
          content: buffered,
          timestamp: Date.now(),
        });
        buffers.delete(sessionId);
        conv.updatedAt = Date.now();
      }

      writeToDisk(conv);
    },

    list() {
      if (!existsSync(dir)) return [];

      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      return files.map((f) => {
        const id = f.replace(".json", "");
        const conv = readFromDisk(id)!;
        const firstUser = conv.messages.find((m) => m.role === "user");
        return {
          id: conv.id,
          preview: firstUser?.content ?? "",
          messageCount: conv.messages.length,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        };
      });
    },

    get(id) {
      const cached = active.get(id);
      if (cached) return cached;
      return readFromDisk(id);
    },

    create(channel?) {
      const uuid = randomUUID();
      const id = channel ? `${channel}:${uuid}` : uuid;
      const now = Date.now();
      const conv: ConversationFile = {
        id,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      active.set(id, conv);
      writeToDisk(conv);
      return id;
    },

    delete(id) {
      const path = filePath(id);
      if (!existsSync(path)) return false;
      unlinkSync(path);
      active.delete(id);
      buffers.delete(id);
      return true;
    },

    search(query, opts?) {
      if (!existsSync(dir)) return [];
      const limit = opts?.limit ?? Infinity;
      const lowerQuery = query.toLowerCase();
      const results: SearchResult[] = [];

      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        const id = f.replace(".json", "");
        const conv = readFromDisk(id);
        if (!conv) continue;

        for (let i = 0; i < conv.messages.length; i++) {
          const msg = conv.messages[i];
          if (msg.content.toLowerCase().includes(lowerQuery)) {
            results.push({
              sessionId: conv.id,
              messageIndex: i,
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
              preview: msg.content.length > 100
                ? msg.content.slice(0, 100) + "..."
                : msg.content,
            });
          }
        }
      }

      results.sort((a, b) => b.timestamp - a.timestamp);
      return results.slice(0, limit);
    },
  };
}
