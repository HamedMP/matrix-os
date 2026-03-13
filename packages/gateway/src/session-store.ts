import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionEntry {
  sessionId: string;
  updatedAt: number;
  channel: string;
  senderId: string;
  senderName?: string;
  chatId?: string;
}

export interface SessionStore {
  get(key: string): string | undefined;
  getEntry(key: string): SessionEntry | undefined;
  set(key: string, sessionId: string, meta?: Partial<SessionEntry>): void;
  delete(key: string): void;
  size(): number;
  entries(): IterableIterator<[string, SessionEntry]>;
}

const DEFAULT_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SAVE_DEBOUNCE_MS = 1000;

export function createSessionStore(
  filePath: string,
  pruneAfterMs = DEFAULT_PRUNE_AFTER_MS,
): SessionStore {
  const sessions = new Map<string, SessionEntry>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw)) {
        const e = entry as SessionEntry;
        if (e.sessionId && e.updatedAt && now - e.updatedAt < pruneAfterMs) {
          sessions.set(key, e);
        }
      }
    } catch {
      // Corrupt file — start fresh
    }
  }

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const obj: Record<string, SessionEntry> = {};
        for (const [key, entry] of sessions) {
          obj[key] = entry;
        }
        writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");
      } catch {
        // Best-effort persistence
      }
    }, SAVE_DEBOUNCE_MS);
  }

  return {
    get(key) {
      const entry = sessions.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.updatedAt > pruneAfterMs) {
        sessions.delete(key);
        save();
        return undefined;
      }
      return entry.sessionId;
    },

    getEntry(key) {
      const entry = sessions.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.updatedAt > pruneAfterMs) {
        sessions.delete(key);
        save();
        return undefined;
      }
      return entry;
    },

    set(key, sessionId, meta) {
      const [channel, senderId] = key.split(":", 2);
      sessions.set(key, {
        sessionId,
        updatedAt: Date.now(),
        channel: meta?.channel ?? channel ?? "unknown",
        senderId: meta?.senderId ?? senderId ?? "unknown",
        senderName: meta?.senderName,
        chatId: meta?.chatId,
      });
      save();
    },

    delete(key) {
      sessions.delete(key);
      save();
    },

    size() {
      return sessions.size;
    },

    entries() {
      return sessions.entries();
    },
  };
}
