import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "../../packages/kernel/src/prompt.js";

function createTestHome(): string {
  const home = resolve(mkdtempSync(join(tmpdir(), "prompt-ctx-")));
  mkdirSync(join(home, "agents", "knowledge"), { recursive: true });
  mkdirSync(join(home, "agents", "skills"), { recursive: true });
  mkdirSync(join(home, "system"), { recursive: true });
  mkdirSync(join(home, "apps"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "agents", "system-prompt.md"), "You are the Matrix OS kernel.");
  return home;
}

describe("system prompt context", () => {
  let home: string;
  beforeEach(() => { home = createTestHome(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  describe("installed apps listing", () => {
    it("lists apps from ~/apps/ directory", () => {
      writeFileSync(join(home, "apps", "todo.html"), "<html>todo</html>");
      writeFileSync(join(home, "apps", "notes.html"), "<html>notes</html>");
      mkdirSync(join(home, "apps", "calculator"));
      writeFileSync(join(home, "apps", "calculator", "index.html"), "<html>calc</html>");

      const prompt = buildSystemPrompt(home);
      expect(prompt).toContain("## Installed Apps");
      expect(prompt).toContain("todo");
      expect(prompt).toContain("notes");
      expect(prompt).toContain("calculator");
    });

    it("shows empty message when no apps installed", () => {
      const prompt = buildSystemPrompt(home);
      expect(prompt).toContain("No apps installed");
    });

    it("excludes .matrix.md manifest files from app listing", () => {
      writeFileSync(join(home, "apps", "todo.html"), "<html>todo</html>");
      writeFileSync(join(home, "apps", "todo.matrix.md"), "---\nname: Todo\n---");

      const prompt = buildSystemPrompt(home);
      expect(prompt).toContain("todo");
      expect(prompt).not.toContain("todo.matrix.md");
    });
  });

  describe("app data summary", () => {
    it("lists data directories and their keys", () => {
      mkdirSync(join(home, "data", "todo"), { recursive: true });
      writeFileSync(join(home, "data", "todo", "tasks.json"), "[]");
      mkdirSync(join(home, "data", "notes"), { recursive: true });
      writeFileSync(join(home, "data", "notes", "notes.json"), "[]");
      writeFileSync(join(home, "data", "notes", "settings.json"), "{}");

      const prompt = buildSystemPrompt(home);
      expect(prompt).toContain("## App Data");
      expect(prompt).toContain("todo");
      expect(prompt).toContain("tasks");
      expect(prompt).toContain("notes");
    });

    it("shows empty message when no data exists", () => {
      const prompt = buildSystemPrompt(home);
      expect(prompt).toContain("No app data");
    });
  });

  describe("conversation summaries in prompt", () => {
    it("includes recent conversation summaries", () => {
      mkdirSync(join(home, "system", "summaries"), { recursive: true });
      writeFileSync(
        join(home, "system", "summaries", "session-1.md"),
        "---\nsession: session-1\ndate: 2026-03-13\ntimestamp: 2026-03-13T10:00:00Z\n---\n\nUser asked to add todo. AI added it.\n"
      );

      const prompt = buildSystemPrompt(home);
      expect(prompt).toContain("Recent Conversations");
      expect(prompt).toContain("add todo");
    });

    it("limits to 5 most recent summaries", () => {
      mkdirSync(join(home, "system", "summaries"), { recursive: true });
      for (let i = 0; i < 8; i++) {
        writeFileSync(
          join(home, "system", "summaries", `s${i}.md`),
          `---\nsession: s${i}\ndate: 2026-03-13\ntimestamp: 2026-03-13T1${i}:00:00Z\n---\n\nSummary ${i}\n`
        );
      }

      const prompt = buildSystemPrompt(home);
      const matches = prompt.match(/Summary \d/g) ?? [];
      expect(matches.length).toBeLessThanOrEqual(5);
    });

    it("shows no section when no summaries exist", () => {
      const prompt = buildSystemPrompt(home);
      expect(prompt).not.toContain("Recent Conversations");
    });
  });
});
