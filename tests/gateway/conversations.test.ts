import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createConversationStore,
  type ConversationFile,
  type SearchResult,
} from "../../packages/gateway/src/conversations.js";

function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "conv-test-"));
  const convDir = join(dir, "system", "conversations");
  const { mkdirSync } = require("node:fs");
  mkdirSync(convDir, { recursive: true });
  return dir;
}

describe("ConversationStore", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = tmpHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("begin creates a new conversation", () => {
    const store = createConversationStore(homePath);
    store.begin("sess-1");

    const conv = store.get("sess-1");
    expect(conv).not.toBeNull();
    expect(conv!.id).toBe("sess-1");
    expect(conv!.messages).toEqual([]);
  });

  it("begin resumes an existing conversation from disk", () => {
    const store1 = createConversationStore(homePath);
    store1.begin("sess-1");
    store1.addUserMessage("sess-1", "hello");
    store1.appendAssistantText("sess-1", "Hi!");
    store1.finalize("sess-1");

    const store2 = createConversationStore(homePath);
    store2.begin("sess-1");

    const conv = store2.get("sess-1");
    expect(conv!.messages).toHaveLength(2);
    expect(conv!.messages[0].content).toBe("hello");
    expect(conv!.messages[1].content).toBe("Hi!");
  });

  it("addUserMessage appends and writes to disk immediately", () => {
    const store = createConversationStore(homePath);
    store.begin("sess-1");
    store.addUserMessage("sess-1", "hello");

    const filePath = join(
      homePath,
      "system",
      "conversations",
      "sess-1.json",
    );
    expect(existsSync(filePath)).toBe(true);

    const disk = JSON.parse(readFileSync(filePath, "utf-8")) as ConversationFile;
    expect(disk.messages).toHaveLength(1);
    expect(disk.messages[0]).toMatchObject({
      role: "user",
      content: "hello",
    });
  });

  it("appendAssistantText buffers in memory without disk write", () => {
    const store = createConversationStore(homePath);
    store.begin("sess-1");
    store.addUserMessage("sess-1", "hello");
    store.appendAssistantText("sess-1", "Hi ");
    store.appendAssistantText("sess-1", "there!");

    const filePath = join(
      homePath,
      "system",
      "conversations",
      "sess-1.json",
    );
    const disk = JSON.parse(readFileSync(filePath, "utf-8")) as ConversationFile;
    expect(disk.messages).toHaveLength(1);
  });

  it("finalize flushes buffered assistant text to disk", () => {
    const store = createConversationStore(homePath);
    store.begin("sess-1");
    store.addUserMessage("sess-1", "hello");
    store.appendAssistantText("sess-1", "Hi ");
    store.appendAssistantText("sess-1", "there!");
    store.finalize("sess-1");

    const conv = store.get("sess-1");
    expect(conv!.messages).toHaveLength(2);
    expect(conv!.messages[1]).toMatchObject({
      role: "assistant",
      content: "Hi there!",
    });
  });

  it("finalize is a no-op if no assistant text was buffered", () => {
    const store = createConversationStore(homePath);
    store.begin("sess-1");
    store.addUserMessage("sess-1", "hello");
    store.finalize("sess-1");

    const conv = store.get("sess-1");
    expect(conv!.messages).toHaveLength(1);
  });

  it("list returns metadata for all conversations", () => {
    const store = createConversationStore(homePath);
    store.begin("sess-1");
    store.addUserMessage("sess-1", "hello from session 1");
    store.appendAssistantText("sess-1", "Reply 1");
    store.finalize("sess-1");

    store.begin("sess-2");
    store.addUserMessage("sess-2", "hello from session 2");
    store.finalize("sess-2");

    const list = store.list();
    expect(list).toHaveLength(2);

    const s1 = list.find((c) => c.id === "sess-1");
    expect(s1).toBeDefined();
    expect(s1!.messageCount).toBe(2);
    expect(s1!.preview).toBe("hello from session 1");

    const s2 = list.find((c) => c.id === "sess-2");
    expect(s2).toBeDefined();
    expect(s2!.messageCount).toBe(1);
  });

  it("list returns empty array when no conversations exist", () => {
    const store = createConversationStore(homePath);
    expect(store.list()).toEqual([]);
  });

  it("get returns null for unknown conversation", () => {
    const store = createConversationStore(homePath);
    expect(store.get("nonexistent")).toBeNull();
  });

  it("survives restart (full flow)", () => {
    const store1 = createConversationStore(homePath);
    store1.begin("sess-1");
    store1.addUserMessage("sess-1", "first message");
    store1.appendAssistantText("sess-1", "first reply");
    store1.finalize("sess-1");

    const store2 = createConversationStore(homePath);
    const list = store2.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("sess-1");

    const conv = store2.get("sess-1");
    expect(conv!.messages).toHaveLength(2);
    expect(conv!.messages[0].content).toBe("first message");
    expect(conv!.messages[1].content).toBe("first reply");
  });

  it("handles multiple independent conversations", () => {
    const store = createConversationStore(homePath);

    store.begin("a");
    store.begin("b");

    store.addUserMessage("a", "message for A");
    store.addUserMessage("b", "message for B");

    store.appendAssistantText("a", "reply to A");
    store.appendAssistantText("b", "reply to B");

    store.finalize("a");
    store.finalize("b");

    const convA = store.get("a");
    const convB = store.get("b");

    expect(convA!.messages[0].content).toBe("message for A");
    expect(convA!.messages[1].content).toBe("reply to A");
    expect(convB!.messages[0].content).toBe("message for B");
    expect(convB!.messages[1].content).toBe("reply to B");
  });

  it("updates timestamps correctly", () => {
    const store = createConversationStore(homePath);
    store.begin("sess-1");

    const before = Date.now();
    store.addUserMessage("sess-1", "hello");
    const after = Date.now();

    const conv = store.get("sess-1");
    expect(conv!.updatedAt).toBeGreaterThanOrEqual(before);
    expect(conv!.updatedAt).toBeLessThanOrEqual(after);
    expect(conv!.createdAt).toBeGreaterThanOrEqual(0);
  });

  it("list reads from disk, not just memory", () => {
    const store1 = createConversationStore(homePath);
    store1.begin("sess-1");
    store1.addUserMessage("sess-1", "hello");
    store1.finalize("sess-1");

    const store2 = createConversationStore(homePath);
    const list = store2.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("sess-1");
  });

  describe("create", () => {
    it("returns a new session with unique ID", () => {
      const store = createConversationStore(homePath);
      const id1 = store.create();
      const id2 = store.create();

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);

      const conv1 = store.get(id1);
      expect(conv1).not.toBeNull();
      expect(conv1!.id).toBe(id1);
      expect(conv1!.messages).toEqual([]);
    });

    it("accepts an optional channel prefix", () => {
      const store = createConversationStore(homePath);
      const id = store.create("telegram");

      expect(id).toMatch(/^telegram:/);
      const conv = store.get(id);
      expect(conv).not.toBeNull();
    });

    it("persists to disk immediately", () => {
      const store = createConversationStore(homePath);
      const id = store.create();

      const store2 = createConversationStore(homePath);
      const conv = store2.get(id);
      expect(conv).not.toBeNull();
      expect(conv!.id).toBe(id);
    });

    it("appears in list after creation", () => {
      const store = createConversationStore(homePath);
      store.create();
      store.create();

      expect(store.list()).toHaveLength(2);
    });
  });

  describe("delete", () => {
    it("removes session file and returns true", () => {
      const store = createConversationStore(homePath);
      const id = store.create();
      store.addUserMessage(id, "hello");
      store.finalize(id);

      const result = store.delete(id);
      expect(result).toBe(true);
      expect(store.get(id)).toBeNull();
      expect(store.list().find((c) => c.id === id)).toBeUndefined();
    });

    it("returns false for nonexistent session", () => {
      const store = createConversationStore(homePath);
      expect(store.delete("nonexistent")).toBe(false);
    });

    it("deleted session does not appear in search", () => {
      const store = createConversationStore(homePath);
      const id = store.create();
      store.addUserMessage(id, "unique-search-term");
      store.finalize(id);

      store.delete(id);
      const results = store.search("unique-search-term");
      expect(results).toHaveLength(0);
    });
  });

  describe("search", () => {
    it("finds matching messages across sessions", () => {
      const store = createConversationStore(homePath);

      const id1 = store.create();
      store.addUserMessage(id1, "hello world");
      store.appendAssistantText(id1, "Hi there!");
      store.finalize(id1);

      const id2 = store.create();
      store.addUserMessage(id2, "goodbye world");
      store.finalize(id2);

      const results = store.search("world");
      expect(results.length).toBe(2);
      expect(results.every((r) => r.content.includes("world"))).toBe(true);
    });

    it("returns empty array when nothing matches", () => {
      const store = createConversationStore(homePath);
      const id = store.create();
      store.addUserMessage(id, "hello");
      store.finalize(id);

      expect(store.search("xyz-no-match")).toEqual([]);
    });

    it("returns results with correct shape", () => {
      const store = createConversationStore(homePath);
      const id = store.create();
      store.addUserMessage(id, "test message content");
      store.finalize(id);

      const results = store.search("test message");
      expect(results).toHaveLength(1);

      const r = results[0];
      expect(r.sessionId).toBe(id);
      expect(r.messageIndex).toBe(0);
      expect(r.role).toBe("user");
      expect(r.content).toBe("test message content");
      expect(typeof r.timestamp).toBe("number");
      expect(typeof r.preview).toBe("string");
    });

    it("search is case-insensitive", () => {
      const store = createConversationStore(homePath);
      const id = store.create();
      store.addUserMessage(id, "Hello World");
      store.finalize(id);

      const results = store.search("hello world");
      expect(results).toHaveLength(1);
    });

    it("respects limit option", () => {
      const store = createConversationStore(homePath);
      for (let i = 0; i < 5; i++) {
        const id = store.create();
        store.addUserMessage(id, `matching term ${i}`);
        store.finalize(id);
      }

      const results = store.search("matching term", { limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("results are ranked by recency (newest first)", () => {
      const store = createConversationStore(homePath);

      const id1 = store.create();
      store.addUserMessage(id1, "search target old");
      store.finalize(id1);

      const id2 = store.create();
      store.addUserMessage(id2, "search target new");
      store.finalize(id2);

      const results = store.search("search target");
      expect(results.length).toBe(2);
      expect(results[0].timestamp).toBeGreaterThanOrEqual(results[1].timestamp);
    });

    it("sessions are isolated: messages don't leak between sessions", () => {
      const store = createConversationStore(homePath);

      const id1 = store.create();
      store.addUserMessage(id1, "secret-alpha");
      store.finalize(id1);

      const id2 = store.create();
      store.addUserMessage(id2, "secret-beta");
      store.finalize(id2);

      const alpha = store.search("secret-alpha");
      expect(alpha).toHaveLength(1);
      expect(alpha[0].sessionId).toBe(id1);

      const beta = store.search("secret-beta");
      expect(beta).toHaveLength(1);
      expect(beta[0].sessionId).toBe(id2);
    });

    it("searches both user and assistant messages", () => {
      const store = createConversationStore(homePath);
      const id = store.create();
      store.addUserMessage(id, "tell me about quantum");
      store.appendAssistantText(id, "Quantum mechanics is fascinating");
      store.finalize(id);

      const userResults = store.search("quantum");
      expect(userResults.length).toBe(2);
      expect(userResults.some((r) => r.role === "user")).toBe(true);
      expect(userResults.some((r) => r.role === "assistant")).toBe(true);
    });

    it("preview is truncated for long messages", () => {
      const store = createConversationStore(homePath);
      const id = store.create();
      const longMsg = "a".repeat(300);
      store.addUserMessage(id, longMsg);
      store.finalize(id);

      const results = store.search("aaa");
      expect(results).toHaveLength(1);
      expect(results[0].preview.length).toBeLessThanOrEqual(150);
    });
  });
});
