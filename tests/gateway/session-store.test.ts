import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createSessionStore } from "../../packages/gateway/src/session-store.js";

describe("session-store", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = resolve(mkdtempSync(join(tmpdir(), "sess-store-")));
    filePath = join(dir, "system", "sessions.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("basic operations", () => {
    it("should store and retrieve a session", () => {
      const store = createSessionStore(filePath);
      store.set("telegram:123", "sess-abc");
      expect(store.get("telegram:123")).toBe("sess-abc");
    });

    it("should return undefined for missing keys", () => {
      const store = createSessionStore(filePath);
      expect(store.get("telegram:unknown")).toBeUndefined();
    });

    it("should overwrite existing sessions", () => {
      const store = createSessionStore(filePath);
      store.set("telegram:123", "sess-old");
      store.set("telegram:123", "sess-new");
      expect(store.get("telegram:123")).toBe("sess-new");
    });

    it("should delete sessions", () => {
      const store = createSessionStore(filePath);
      store.set("telegram:123", "sess-abc");
      store.delete("telegram:123");
      expect(store.get("telegram:123")).toBeUndefined();
    });

    it("should track size", () => {
      const store = createSessionStore(filePath);
      expect(store.size()).toBe(0);
      store.set("telegram:123", "sess-a");
      store.set("discord:456", "sess-b");
      expect(store.size()).toBe(2);
    });

    it("should support multiple channel types as keys", () => {
      const store = createSessionStore(filePath);
      store.set("telegram:111", "sess-t");
      store.set("discord:222", "sess-d");
      store.set("web:333", "sess-w");
      expect(store.get("telegram:111")).toBe("sess-t");
      expect(store.get("discord:222")).toBe("sess-d");
      expect(store.get("web:333")).toBe("sess-w");
    });
  });

  describe("persistence", () => {
    it("should save to disk after set", () => {
      const store = createSessionStore(filePath);
      store.set("telegram:123", "sess-abc");
      vi.advanceTimersByTime(1500);
      expect(existsSync(filePath)).toBe(true);
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(data["telegram:123"].sessionId).toBe("sess-abc");
    });

    it("should reload from disk on creation", () => {
      mkdirSync(join(dir, "system"), { recursive: true });
      writeFileSync(filePath, JSON.stringify({
        "telegram:123": { sessionId: "sess-persisted", updatedAt: Date.now() },
      }));

      const store = createSessionStore(filePath);
      expect(store.get("telegram:123")).toBe("sess-persisted");
    });

    it("should survive store recreation (simulates restart)", () => {
      const store1 = createSessionStore(filePath);
      store1.set("telegram:123", "sess-abc");
      vi.advanceTimersByTime(1500);

      const store2 = createSessionStore(filePath);
      expect(store2.get("telegram:123")).toBe("sess-abc");
    });

    it("should handle corrupt file gracefully", () => {
      mkdirSync(join(dir, "system"), { recursive: true });
      writeFileSync(filePath, "not json{{{");

      const store = createSessionStore(filePath);
      expect(store.size()).toBe(0);
      store.set("telegram:123", "sess-new");
      expect(store.get("telegram:123")).toBe("sess-new");
    });

    it("should handle missing file gracefully", () => {
      const store = createSessionStore(join(dir, "nonexistent", "sessions.json"));
      expect(store.size()).toBe(0);
    });

    it("should create parent directories on save", () => {
      const deepPath = join(dir, "a", "b", "c", "sessions.json");
      const store = createSessionStore(deepPath);
      store.set("telegram:123", "sess-abc");
      vi.advanceTimersByTime(1500);
      expect(existsSync(deepPath)).toBe(true);
    });
  });

  describe("pruning", () => {
    it("should prune expired sessions on load", () => {
      mkdirSync(join(dir, "system"), { recursive: true });
      const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
      writeFileSync(filePath, JSON.stringify({
        "telegram:old": { sessionId: "sess-old", updatedAt: thirtyOneDaysAgo },
        "telegram:fresh": { sessionId: "sess-fresh", updatedAt: Date.now() },
      }));

      const store = createSessionStore(filePath);
      expect(store.get("telegram:old")).toBeUndefined();
      expect(store.get("telegram:fresh")).toBe("sess-fresh");
    });

    it("should prune on get if session expired since load", () => {
      const store = createSessionStore(filePath, 5000);
      store.set("telegram:123", "sess-abc");
      vi.advanceTimersByTime(6000);
      expect(store.get("telegram:123")).toBeUndefined();
    });

    it("should respect custom prune duration", () => {
      const oneHour = 60 * 60 * 1000;
      mkdirSync(join(dir, "system"), { recursive: true });
      writeFileSync(filePath, JSON.stringify({
        "telegram:recent": { sessionId: "sess-a", updatedAt: Date.now() - oneHour + 1000 },
        "telegram:stale": { sessionId: "sess-b", updatedAt: Date.now() - oneHour - 1000 },
      }));

      const store = createSessionStore(filePath, oneHour);
      expect(store.get("telegram:recent")).toBe("sess-a");
      expect(store.get("telegram:stale")).toBeUndefined();
    });
  });

  describe("channel metadata", () => {
    it("should auto-derive channel and senderId from key", () => {
      const store = createSessionStore(filePath);
      store.set("telegram:123", "sess-abc");
      const entry = store.getEntry("telegram:123");
      expect(entry?.channel).toBe("telegram");
      expect(entry?.senderId).toBe("123");
    });

    it("should store explicit metadata", () => {
      const store = createSessionStore(filePath);
      store.set("telegram:123", "sess-abc", {
        channel: "telegram",
        senderId: "123",
        senderName: "Alice",
        chatId: "456",
      });
      const entry = store.getEntry("telegram:123");
      expect(entry?.senderName).toBe("Alice");
      expect(entry?.chatId).toBe("456");
    });

    it("should persist metadata to disk", () => {
      const store = createSessionStore(filePath);
      store.set("telegram:123", "sess-abc", { senderName: "Bob", chatId: "789" });
      vi.advanceTimersByTime(1500);

      const store2 = createSessionStore(filePath);
      const entry = store2.getEntry("telegram:123");
      expect(entry?.senderName).toBe("Bob");
      expect(entry?.chatId).toBe("789");
    });

    it("should return undefined from getEntry for missing keys", () => {
      const store = createSessionStore(filePath);
      expect(store.getEntry("missing:key")).toBeUndefined();
    });

    it("should prune expired entries from getEntry", () => {
      const store = createSessionStore(filePath, 5000);
      store.set("telegram:123", "sess-abc");
      vi.advanceTimersByTime(6000);
      expect(store.getEntry("telegram:123")).toBeUndefined();
    });
  });

  describe("debounce", () => {
    it("should debounce rapid writes", () => {
      const store = createSessionStore(filePath);
      store.set("a", "1");
      store.set("b", "2");
      store.set("c", "3");

      expect(existsSync(filePath)).toBe(false);

      vi.advanceTimersByTime(1500);

      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(Object.keys(data)).toHaveLength(3);
    });
  });
});
