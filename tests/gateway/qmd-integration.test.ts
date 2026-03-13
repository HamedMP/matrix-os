import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

function qmdAvailable(): boolean {
  try {
    execFileSync("qmd", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasQmd = qmdAvailable();

describe.skipIf(!hasQmd)("QMD integration", () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(() => {
    home = resolve(mkdtempSync(join(tmpdir(), "qmd-test-")));
    mkdirSync(join(home, "agents", "knowledge"), { recursive: true });
    mkdirSync(join(home, "agents", "skills"), { recursive: true });
    mkdirSync(join(home, "system", "summaries"), { recursive: true });
    mkdirSync(join(home, "system", "conversations"), { recursive: true });
    mkdirSync(join(home, "system", "qmd"), { recursive: true });
    mkdirSync(join(home, "apps"), { recursive: true });

    env = {
      ...process.env,
      XDG_CACHE_HOME: join(home, "system", "qmd"),
      XDG_CONFIG_HOME: join(home, "system", "qmd"),
    } as Record<string, string>;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function qmd(args: string[]): string {
    return execFileSync("qmd", args, { env, encoding: "utf-8", timeout: 10000 }).trim();
  }

  function addCollection(name: string, path: string, mask: string) {
    mkdirSync(path, { recursive: true });
    qmd(["collection", "add", path, "--name", name, "--mask", mask]);
  }

  describe("collection management", () => {
    it("should create and list collections", () => {
      addCollection("knowledge", join(home, "agents", "knowledge"), "**/*.md");
      const list = qmd(["collection", "list"]);
      expect(list).toContain("knowledge");
    });

    it("should index files in collections", () => {
      writeFileSync(join(home, "agents", "knowledge", "test.md"), "# Test Doc\nSome content.");
      addCollection("knowledge", join(home, "agents", "knowledge"), "**/*.md");
      qmd(["update"]);
      const status = qmd(["status"]);
      expect(status).toContain("1 files indexed");
    });

    it("should support multiple collections", () => {
      writeFileSync(join(home, "agents", "knowledge", "k.md"), "# Knowledge");
      writeFileSync(join(home, "agents", "skills", "s.md"), "# Skill");
      addCollection("knowledge", join(home, "agents", "knowledge"), "**/*.md");
      addCollection("skills", join(home, "agents", "skills"), "**/*.md");
      qmd(["update"]);
      const status = qmd(["status"]);
      expect(status).toContain("2 files indexed");
    });
  });

  describe("BM25 search", () => {
    beforeEach(() => {
      writeFileSync(
        join(home, "agents", "knowledge", "channels.md"),
        "# Channel Routing\nTelegram messages are routed through the dispatcher to the kernel.",
      );
      writeFileSync(
        join(home, "agents", "skills", "todo.md"),
        "# Todo Skill\nManage tasks, to-do items, and reminders for the user.",
      );
      writeFileSync(
        join(home, "system", "summaries", "session1.md"),
        "# Session Summary\nUser asked about the weather forecast and installed a calculator app.",
      );
      addCollection("knowledge", join(home, "agents", "knowledge"), "**/*.md");
      addCollection("skills", join(home, "agents", "skills"), "**/*.md");
      addCollection("summaries", join(home, "system", "summaries"), "**/*.md");
      qmd(["update"]);
    });

    it("should find knowledge files by keyword", () => {
      const result = qmd(["search", "telegram dispatcher", "--json"]);
      const parsed = JSON.parse(result);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].file).toContain("knowledge/channels.md");
    });

    it("should find skills by keyword", () => {
      const result = qmd(["search", "todo tasks reminders", "--json"]);
      const parsed = JSON.parse(result);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].file).toContain("skills/todo.md");
    });

    it("should find conversation summaries", () => {
      const result = qmd(["search", "weather calculator", "--json"]);
      const parsed = JSON.parse(result);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].file).toContain("summaries/session1.md");
    });

    it("should return empty for unrelated queries", () => {
      const result = qmd(["search", "quantum physics blockchain", "--json"]);
      const parsed = JSON.parse(result);
      expect(parsed).toEqual([]);
    });

    it("should filter by collection", () => {
      const result = qmd(["search", "manage", "-c", "skills", "--json"]);
      const parsed = JSON.parse(result);
      for (const r of parsed) {
        expect(r.file).toContain("skills/");
      }
    });
  });

  describe("privacy isolation", () => {
    it("should only see its own user data", () => {
      writeFileSync(
        join(home, "agents", "knowledge", "secret.md"),
        "# My Secret\nAlice password is 12345.",
      );
      addCollection("knowledge", join(home, "agents", "knowledge"), "**/*.md");
      qmd(["update"]);

      const result = qmd(["search", "alice password", "--json"]);
      const parsed = JSON.parse(result);
      expect(parsed.length).toBeGreaterThan(0);

      const otherHome = resolve(mkdtempSync(join(tmpdir(), "qmd-other-")));
      mkdirSync(join(otherHome, "system", "qmd"), { recursive: true });
      mkdirSync(join(otherHome, "agents", "knowledge"), { recursive: true });
      writeFileSync(join(otherHome, "agents", "knowledge", "public.md"), "# Public Info");

      const otherEnv = {
        ...process.env,
        XDG_CACHE_HOME: join(otherHome, "system", "qmd"),
        XDG_CONFIG_HOME: join(otherHome, "system", "qmd"),
      } as Record<string, string>;

      execFileSync(
        "qmd",
        ["collection", "add", join(otherHome, "agents", "knowledge"), "--name", "knowledge", "--mask", "**/*.md"],
        { env: otherEnv, encoding: "utf-8" },
      );
      execFileSync("qmd", ["update"], { env: otherEnv, encoding: "utf-8" });
      const otherResult = execFileSync("qmd", ["search", "alice password", "--json"], {
        env: otherEnv,
        encoding: "utf-8",
      }).trim();
      const otherParsed = JSON.parse(otherResult);
      expect(otherParsed).toEqual([]);

      rmSync(otherHome, { recursive: true, force: true });
    });
  });

  describe("index persistence", () => {
    it("should store index in user home directory", () => {
      writeFileSync(join(home, "agents", "knowledge", "test.md"), "# Test");
      addCollection("knowledge", join(home, "agents", "knowledge"), "**/*.md");
      qmd(["update"]);

      const indexPath = join(home, "system", "qmd", "qmd", "index.sqlite");
      expect(existsSync(indexPath)).toBe(true);
    });

    it("should store config in user home directory", () => {
      addCollection("knowledge", join(home, "agents", "knowledge"), "**/*.md");
      const configPath = join(home, "system", "qmd", "qmd", "index.yml");
      expect(existsSync(configPath)).toBe(true);
    });
  });
});
