import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { appDataHandler } from "../../packages/kernel/src/app-data.js";

describe("app_data IPC tool", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "app-data-test-")));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("write action", () => {
    it("writes data to ~/data/{app}/{key}.json", async () => {
      const result = await appDataHandler(homePath, {
        action: "write",
        app: "task-manager",
        key: "tasks",
        value: JSON.stringify([{ id: 1, text: "Buy milk" }]),
      });

      expect(result.content[0].text).toContain("Written");
      const filePath = join(homePath, "data/task-manager/tasks.json");
      expect(existsSync(filePath)).toBe(true);
      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(content).toEqual([{ id: 1, text: "Buy milk" }]);
    });

    it("creates data directory if it does not exist", async () => {
      await appDataHandler(homePath, {
        action: "write",
        app: "notes",
        key: "entries",
        value: JSON.stringify({ note: "hello" }),
      });

      expect(existsSync(join(homePath, "data/notes"))).toBe(true);
    });

    it("overwrites existing data", async () => {
      mkdirSync(join(homePath, "data/notes"), { recursive: true });
      writeFileSync(
        join(homePath, "data/notes/entries.json"),
        JSON.stringify({ old: true }),
      );

      await appDataHandler(homePath, {
        action: "write",
        app: "notes",
        key: "entries",
        value: JSON.stringify({ new: true }),
      });

      const content = JSON.parse(
        readFileSync(join(homePath, "data/notes/entries.json"), "utf-8"),
      );
      expect(content).toEqual({ new: true });
    });

    it("returns error when key is missing", async () => {
      const result = await appDataHandler(homePath, {
        action: "write",
        app: "notes",
        value: JSON.stringify("data"),
      });
      expect(result.content[0].text).toContain("required");
    });

    it("returns error when value is missing", async () => {
      const result = await appDataHandler(homePath, {
        action: "write",
        app: "notes",
        key: "entries",
      });
      expect(result.content[0].text).toContain("required");
    });
  });

  describe("read action", () => {
    it("reads existing data file", async () => {
      mkdirSync(join(homePath, "data/expense-tracker"), { recursive: true });
      writeFileSync(
        join(homePath, "data/expense-tracker/expenses.json"),
        JSON.stringify([{ amount: 42, desc: "Coffee" }]),
      );

      const result = await appDataHandler(homePath, {
        action: "read",
        app: "expense-tracker",
        key: "expenses",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([{ amount: 42, desc: "Coffee" }]);
    });

    it("returns helpful message for missing data file", async () => {
      const result = await appDataHandler(homePath, {
        action: "read",
        app: "nonexistent-app",
        key: "data",
      });

      expect(result.content[0].text).toContain("No data found");
    });

    it("returns error when key is missing", async () => {
      const result = await appDataHandler(homePath, {
        action: "read",
        app: "notes",
      });
      expect(result.content[0].text).toContain("required");
    });
  });

  describe("list action", () => {
    it("lists keys for an app", async () => {
      mkdirSync(join(homePath, "data/task-manager"), { recursive: true });
      writeFileSync(
        join(homePath, "data/task-manager/tasks.json"),
        "[]",
      );
      writeFileSync(
        join(homePath, "data/task-manager/settings.json"),
        "{}",
      );

      const result = await appDataHandler(homePath, {
        action: "list",
        app: "task-manager",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sort()).toEqual(["settings", "tasks"]);
    });

    it("returns empty array for app with no data", async () => {
      const result = await appDataHandler(homePath, {
        action: "list",
        app: "empty-app",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([]);
    });
  });

  describe("input sanitization", () => {
    it("sanitizes app name to prevent traversal", async () => {
      const result = await appDataHandler(homePath, {
        action: "write",
        app: "../../../etc",
        key: "passwd",
        value: JSON.stringify("hacked"),
      });

      expect(result.content[0].text).toContain("Written");
      // The sanitized path should be safe
      expect(existsSync(join(homePath, "data/etc/passwd.json"))).toBe(true);
      // Original traversal path should not exist
      expect(existsSync("/etc/passwd.json")).toBe(false);
    });

    it("sanitizes key to prevent traversal", async () => {
      await appDataHandler(homePath, {
        action: "write",
        app: "safe-app",
        key: "../../etc/passwd",
        value: JSON.stringify("data"),
      });

      expect(existsSync(join(homePath, "data/safe-app/etcpasswd.json"))).toBe(true);
    });
  });
});
