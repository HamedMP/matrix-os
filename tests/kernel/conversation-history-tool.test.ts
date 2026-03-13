import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  listConversationSummaries,
  getConversationMessages,
} from "../../packages/kernel/src/conversation-history.js";

describe("conversation_history tool logic", () => {
  let home: string;

  beforeEach(() => {
    home = resolve(mkdtempSync(join(tmpdir(), "conv-history-")));
    mkdirSync(join(home, "system", "conversations"), { recursive: true });
    mkdirSync(join(home, "system", "summaries"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("listConversationSummaries", () => {
    it("returns empty array when no summaries exist", () => {
      const result = listConversationSummaries(home);
      expect(result).toEqual([]);
    });

    it("lists summaries with session, date, and body", () => {
      writeFileSync(
        join(home, "system", "summaries", "s1.md"),
        "---\nsession: s1\ndate: 2026-03-13\ntimestamp: 2026-03-13T10:00:00Z\n---\n\nUser discussed todo app\n",
      );
      writeFileSync(
        join(home, "system", "summaries", "s2.md"),
        "---\nsession: s2\ndate: 2026-03-12\ntimestamp: 2026-03-12T09:00:00Z\n---\n\nUser asked about weather\n",
      );

      const result = listConversationSummaries(home);
      expect(result).toHaveLength(2);
      expect(result[0].session).toBe("s1");
      expect(result[0].date).toBe("2026-03-13");
      expect(result[0].summary).toBe("User discussed todo app");
    });

    it("sorts by date descending", () => {
      writeFileSync(
        join(home, "system", "summaries", "old.md"),
        "---\nsession: old\ndate: 2026-03-10\n---\n\nOld conversation\n",
      );
      writeFileSync(
        join(home, "system", "summaries", "new.md"),
        "---\nsession: new\ndate: 2026-03-13\n---\n\nNew conversation\n",
      );

      const result = listConversationSummaries(home);
      expect(result[0].session).toBe("new");
      expect(result[1].session).toBe("old");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        writeFileSync(
          join(home, "system", "summaries", `s${i}.md`),
          `---\nsession: s${i}\ndate: 2026-03-${10 + i}\n---\n\nSummary ${i}\n`,
        );
      }

      const result = listConversationSummaries(home, 2);
      expect(result).toHaveLength(2);
    });

    it("defaults to limit of 10", () => {
      for (let i = 0; i < 15; i++) {
        writeFileSync(
          join(home, "system", "summaries", `s${i}.md`),
          `---\nsession: s${i}\ndate: 2026-03-${String(i).padStart(2, "0")}\n---\n\nSummary ${i}\n`,
        );
      }

      const result = listConversationSummaries(home);
      expect(result).toHaveLength(10);
    });

    it("ignores non-.md files", () => {
      writeFileSync(
        join(home, "system", "summaries", "s1.md"),
        "---\nsession: s1\ndate: 2026-03-13\n---\n\nSummary\n",
      );
      writeFileSync(
        join(home, "system", "summaries", "notes.txt"),
        "not a summary",
      );

      const result = listConversationSummaries(home);
      expect(result).toHaveLength(1);
    });

    it("handles missing summaries directory gracefully", () => {
      rmSync(join(home, "system", "summaries"), { recursive: true, force: true });
      const result = listConversationSummaries(home);
      expect(result).toEqual([]);
    });

    it("skips malformed files", () => {
      writeFileSync(
        join(home, "system", "summaries", "good.md"),
        "---\nsession: good\ndate: 2026-03-13\n---\n\nGood summary\n",
      );
      writeFileSync(
        join(home, "system", "summaries", "bad.md"),
        "no frontmatter here",
      );

      const result = listConversationSummaries(home);
      expect(result).toHaveLength(2);
      // The bad file should still have a session name derived from filename
      const badEntry = result.find((r) => r.session === "bad");
      expect(badEntry).toBeDefined();
    });
  });

  describe("getConversationMessages", () => {
    it("returns null when conversation file does not exist", () => {
      const result = getConversationMessages(home, "nonexistent");
      expect(result).toBeNull();
    });

    it("returns messages from a conversation file", () => {
      const conv = {
        id: "test-conv",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          { role: "user", content: "Hello", timestamp: Date.now() },
          { role: "assistant", content: "Hi there!", timestamp: Date.now() },
        ],
      };
      writeFileSync(
        join(home, "system", "conversations", "test-conv.json"),
        JSON.stringify(conv),
      );

      const result = getConversationMessages(home, "test-conv");
      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
      expect(result![0].role).toBe("user");
      expect(result![0].content).toBe("Hello");
      expect(result![1].role).toBe("assistant");
      expect(result![1].content).toBe("Hi there!");
    });

    it("returns only last 30 messages", () => {
      const messages = Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: Date.now() + i,
      }));
      const conv = { id: "long-conv", createdAt: Date.now(), updatedAt: Date.now(), messages };
      writeFileSync(
        join(home, "system", "conversations", "long-conv.json"),
        JSON.stringify(conv),
      );

      const result = getConversationMessages(home, "long-conv");
      expect(result).toHaveLength(30);
      // Should be the LAST 30 messages
      expect(result![0].content).toBe("Message 20");
      expect(result![29].content).toBe("Message 49");
    });

    it("truncates message content to 500 characters", () => {
      const longContent = "x".repeat(1000);
      const conv = {
        id: "trunc-conv",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{ role: "user", content: longContent, timestamp: Date.now() }],
      };
      writeFileSync(
        join(home, "system", "conversations", "trunc-conv.json"),
        JSON.stringify(conv),
      );

      const result = getConversationMessages(home, "trunc-conv");
      expect(result).toHaveLength(1);
      expect(result![0].content.length).toBeLessThanOrEqual(503); // 500 + "..."
      expect(result![0].content.endsWith("...")).toBe(true);
    });

    it("does not truncate short messages", () => {
      const conv = {
        id: "short-conv",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{ role: "user", content: "Short message", timestamp: Date.now() }],
      };
      writeFileSync(
        join(home, "system", "conversations", "short-conv.json"),
        JSON.stringify(conv),
      );

      const result = getConversationMessages(home, "short-conv");
      expect(result![0].content).toBe("Short message");
    });

    it("handles malformed JSON gracefully", () => {
      writeFileSync(
        join(home, "system", "conversations", "bad.json"),
        "not json{{{",
      );

      const result = getConversationMessages(home, "bad");
      expect(result).toBeNull();
    });

    it("handles conversation with no messages array", () => {
      writeFileSync(
        join(home, "system", "conversations", "empty.json"),
        JSON.stringify({ id: "empty" }),
      );

      const result = getConversationMessages(home, "empty");
      expect(result).toEqual([]);
    });
  });
});
