import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createConversationStore,
  type ConversationFile,
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
});
