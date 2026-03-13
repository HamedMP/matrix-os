import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  summarizeConversation,
  saveSummary,
  loadRecentSummaries,
  type ConversationForSummary,
} from "../../packages/gateway/src/conversation-summary.js";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("conversation summary", () => {
  let home: string;
  beforeEach(() => {
    home = resolve(mkdtempSync(join(tmpdir(), "conv-summary-")));
    mkdirSync(join(home, "system", "summaries"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("summarizeConversation", () => {
    it("generates a summary string from messages", () => {
      const conv: ConversationForSummary = {
        id: "test-session",
        messages: [
          { role: "user", content: "Add a task to clean the kitchen" },
          { role: "assistant", content: "Done! I added 'clean the kitchen' to your todo list." },
        ],
      };
      const summary = summarizeConversation(conv);
      expect(summary).toBeTruthy();
      expect(summary.length).toBeGreaterThan(10);
      expect(summary.length).toBeLessThan(500);
    });

    it("returns empty string for empty conversation", () => {
      const conv: ConversationForSummary = { id: "empty", messages: [] };
      expect(summarizeConversation(conv)).toBe("");
    });

    it("truncates very long conversations", () => {
      const messages = Array.from({ length: 100 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `Message ${i}: ${"x".repeat(200)}`,
      }));
      const conv: ConversationForSummary = { id: "long", messages };
      const summary = summarizeConversation(conv);
      expect(summary.length).toBeLessThan(500);
    });

    it("includes first user message", () => {
      const conv: ConversationForSummary = {
        id: "test",
        messages: [
          { role: "user", content: "What is the weather today?" },
          { role: "assistant", content: "I cannot check weather." },
        ],
      };
      const summary = summarizeConversation(conv);
      expect(summary).toContain("weather");
    });

    it("includes last assistant message as outcome", () => {
      const conv: ConversationForSummary = {
        id: "test",
        messages: [
          { role: "user", content: "Add milk to shopping list" },
          { role: "assistant", content: "First response" },
          { role: "user", content: "Also add bread" },
          { role: "assistant", content: "Added milk and bread to your shopping list." },
        ],
      };
      const summary = summarizeConversation(conv);
      expect(summary).toContain("shopping list");
    });

    it("includes first and last user messages for multi-turn conversations", () => {
      const conv: ConversationForSummary = {
        id: "test",
        messages: [
          { role: "user", content: "Create a new todo app" },
          { role: "assistant", content: "Working on it..." },
          { role: "user", content: "Make it dark themed" },
          { role: "assistant", content: "Done, app created with dark theme." },
        ],
      };
      const summary = summarizeConversation(conv);
      expect(summary).toContain("todo app");
      expect(summary).toContain("dark themed");
    });
  });

  describe("saveSummary", () => {
    it("writes summary file to ~/system/summaries/", () => {
      saveSummary(home, "session-123", "User asked to add a todo task. AI added it.");
      const filePath = join(home, "system", "summaries", "session-123.md");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("User asked to add a todo task");
    });

    it("includes timestamp in summary file", () => {
      saveSummary(home, "session-456", "Summary text");
      const content = readFileSync(
        join(home, "system", "summaries", "session-456.md"),
        "utf-8",
      );
      expect(content).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it("includes frontmatter with session and date", () => {
      saveSummary(home, "session-789", "Test summary");
      const content = readFileSync(
        join(home, "system", "summaries", "session-789.md"),
        "utf-8",
      );
      expect(content).toContain("---");
      expect(content).toContain("session: session-789");
      expect(content).toContain("date:");
      expect(content).toContain("timestamp:");
    });

    it("creates summaries dir if it does not exist", () => {
      const freshHome = resolve(mkdtempSync(join(tmpdir(), "conv-summary-fresh-")));
      saveSummary(freshHome, "s1", "A summary");
      expect(existsSync(join(freshHome, "system", "summaries", "s1.md"))).toBe(true);
      rmSync(freshHome, { recursive: true, force: true });
    });

    it("sanitizes session ID in filename", () => {
      saveSummary(home, "session/with/../traversal", "Nope");
      const files = require("node:fs").readdirSync(join(home, "system", "summaries"));
      expect(files.length).toBe(1);
      expect(files[0]).not.toContain("/");
      expect(files[0]).not.toContain("..");
    });
  });

  describe("loadRecentSummaries", () => {
    it("loads most recent summaries", () => {
      saveSummary(home, "old-session", "Old conversation about weather");
      saveSummary(home, "new-session", "Recent conversation about todos");

      const summaries = loadRecentSummaries(home, { limit: 5 });
      expect(summaries.length).toBe(2);
    });

    it("respects limit parameter", () => {
      saveSummary(home, "s1", "Summary 1");
      saveSummary(home, "s2", "Summary 2");
      saveSummary(home, "s3", "Summary 3");

      const summaries = loadRecentSummaries(home, { limit: 2 });
      expect(summaries.length).toBe(2);
    });

    it("returns empty array when no summaries exist", () => {
      const emptyHome = resolve(mkdtempSync(join(tmpdir(), "conv-summary-empty-")));
      const summaries = loadRecentSummaries(emptyHome);
      expect(summaries.length).toBe(0);
      rmSync(emptyHome, { recursive: true, force: true });
    });

    it("parses timestamp from frontmatter", () => {
      saveSummary(home, "ts-test", "Timestamp test summary");
      const summaries = loadRecentSummaries(home);
      expect(summaries.length).toBe(1);
      expect(summaries[0].timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it("parses body after frontmatter", () => {
      saveSummary(home, "body-test", "This is the actual summary content");
      const summaries = loadRecentSummaries(home);
      expect(summaries[0].summary).toBe("This is the actual summary content");
    });

    it("defaults limit to 10", () => {
      for (let i = 0; i < 15; i++) {
        saveSummary(home, `s${i}`, `Summary ${i}`);
      }
      const summaries = loadRecentSummaries(home);
      expect(summaries.length).toBe(10);
    });
  });

  describe("integration: summary triggered on finalize", () => {
    it("creates summary file after conversation finalization", () => {
      const conv: ConversationForSummary = {
        id: "integration-test",
        messages: [
          { role: "user", content: "What is the weather?" },
          { role: "assistant", content: "I don't have weather data." },
        ],
      };

      const summary = summarizeConversation(conv);
      saveSummary(home, conv.id, summary);

      const loaded = loadRecentSummaries(home, { limit: 1 });
      expect(loaded.length).toBe(1);
      expect(loaded[0].sessionId).toBe("integration-test");
      expect(loaded[0].summary).toContain("weather");
    });
  });
});
