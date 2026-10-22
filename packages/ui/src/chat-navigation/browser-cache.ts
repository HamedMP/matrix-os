import { CanonicalChatNavigationResponseSchema, CHAT_NAVIGATION_MAX_BYTES } from "@matrix-os/contracts";
import type { ChatNavigationPersistence } from "./store.js";
const PREFIX = "matrix-chat-navigation:v1:";
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_SCOPES = 3;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const warn = (error: unknown) => console.warn("[chat-navigation] Browser cache unavailable:", error instanceof Error ? error.name : "UnknownError");
export function clearBrowserChatNavigationCache(input?: StorageLike): void {
  try {
    const storage = input ?? window.localStorage;
    for (let index = Math.min(storage.length, 10000) - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX)) {
        storage.removeItem(key);
      }
    }
  }
  catch (error: unknown) {
    warn(error);
  }
}
/** Call only after the shell has established its verified personal viewer scope. */
export function createBrowserChatNavigationPersistence(storage: StorageLike, scope: string, now: () => number = Date.now): ChatNavigationPersistence {
  const key = PREFIX + scope;
  const read = (raw: string | null) => {
    if (!raw || raw.length > CHAT_NAVIGATION_MAX_BYTES + 1024) {
      return null;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || !("storedAt" in value) || typeof value.storedAt !== "number" || !("snapshot" in value)
        || value.storedAt > now() + 60000 || now() - value.storedAt > MAX_AGE) {
        return null;
      }
      const parsed = CanonicalChatNavigationResponseSchema.safeParse(value.snapshot);
      return parsed.success && !parsed.data.truncated && parsed.data.items.every(item => item.persistence === "personal") ? { storedAt: value.storedAt, lastUsedAt: "lastUsedAt" in value && typeof value.lastUsedAt === "number" && value.lastUsedAt <= now() + 60000 ? value.lastUsedAt : value.storedAt, snapshot: parsed.data } : null;
    }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        warn(error);
      }
      return null;
    }
  };
  const sweep = () => {
    const entries: Array<{
      key: string;
      lastUsedAt: number;
    }> = [];
    // Bound enumeration even if an unrelated origin fills storage with keys.
    for (let index = Math.min(storage.length, 10000) - 1; index >= 0; index--) {
      const candidate = storage.key(index);
      if (!candidate?.startsWith(PREFIX)) {
        continue;
      }
      const value = read(storage.getItem(candidate));
      if (!value) {
        storage.removeItem(candidate);
      }
      else {
        entries.push({ key: candidate, lastUsedAt: value.lastUsedAt });
      }
    }
    entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const entry of entries.slice(MAX_SCOPES)) {
      storage.removeItem(entry.key);
    }
  };
  return {
    async load() {
      let value: ReturnType<typeof read>;
      try {
        value = read(storage.getItem(key));
      }
      catch (error: unknown) {
        warn(error);
        return null;
      }
      // Maintenance is best effort. A quota or cleanup failure must not turn
      // an independently verified cached list into a cache miss.
      try {
        if (!value) {
          storage.removeItem(key);
        }
        if (value) {
          try {
            storage.setItem(key, JSON.stringify({ ...value, lastUsedAt: now() }));
          }
          catch (error: unknown) {
            warn(error);
          }
        }
        sweep();
      }
      catch (error: unknown) {
        warn(error);
      }
      return value?.snapshot ?? null;
    },
    async save(snapshot) {
      try {
        const value = CanonicalChatNavigationResponseSchema.parse(snapshot);
        if (value.truncated || value.items.some(item => item.persistence !== "personal")) {
          return;
        }
        storage.setItem(key, JSON.stringify({ storedAt: now(), lastUsedAt: now(), snapshot: value }));
        sweep();
      }
      catch (error: unknown) {
        warn(error);
      }
    },
    async clear() {
      try {
        storage.removeItem(key);
      }
      catch (error: unknown) {
        warn(error);
      }
    },
  };
}
