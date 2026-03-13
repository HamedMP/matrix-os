import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { renameApp, deleteApp } from "../../packages/gateway/src/app-ops.js";

describe("App rename and delete operations", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "app-mgmt-test-")));
    mkdirSync(join(homePath, "apps"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("renameApp", () => {
    it("renames a single-file HTML app", () => {
      writeFileSync(join(homePath, "apps/todo.html"), "<html><body>todo</body></html>");
      writeFileSync(
        join(homePath, "apps/todo.matrix.md"),
        "---\nname: Todo\ncategory: productivity\n---\n",
      );

      const result = renameApp(homePath, "todo", "Task List");
      expect(result.success).toBe(true);
      expect(existsSync(join(homePath, "apps/task-list.html"))).toBe(true);
      expect(existsSync(join(homePath, "apps/task-list.matrix.md"))).toBe(true);
      expect(existsSync(join(homePath, "apps/todo.html"))).toBe(false);

      const md = readFileSync(join(homePath, "apps/task-list.matrix.md"), "utf-8");
      expect(md).toContain("name: Task List");
    });

    it("renames a directory-based app with matrix.json", () => {
      const dir = join(homePath, "apps/my-app");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), "<html></html>");
      writeFileSync(
        join(dir, "matrix.json"),
        JSON.stringify({ name: "My App", runtime: "static" }),
      );

      const result = renameApp(homePath, "my-app", "Renamed App");
      expect(result.success).toBe(true);
      expect(existsSync(join(homePath, "apps/renamed-app"))).toBe(true);
      expect(existsSync(join(homePath, "apps/my-app"))).toBe(false);

      const manifest = JSON.parse(
        readFileSync(join(homePath, "apps/renamed-app/matrix.json"), "utf-8"),
      );
      expect(manifest.name).toBe("Renamed App");
    });

    it("returns error for non-existent app", () => {
      const result = renameApp(homePath, "nonexistent", "New Name");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("returns error for invalid slug", () => {
      const result = renameApp(homePath, "../etc/passwd", "Hacked");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid slug");
    });

    it("returns error for empty name", () => {
      writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");
      const result = renameApp(homePath, "todo", "");
      expect(result.success).toBe(false);
      expect(result.error).toContain("name");
    });

    it("renames data directory if it exists", () => {
      writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");
      mkdirSync(join(homePath, "data/todo"), { recursive: true });
      writeFileSync(join(homePath, "data/todo/items.json"), "[]");

      const result = renameApp(homePath, "todo", "Task List");
      expect(result.success).toBe(true);
      expect(existsSync(join(homePath, "data/task-list/items.json"))).toBe(true);
      expect(existsSync(join(homePath, "data/todo"))).toBe(false);
    });

    it("renames icon file if it exists", () => {
      writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");
      mkdirSync(join(homePath, "system/icons"), { recursive: true });
      writeFileSync(join(homePath, "system/icons/todo.png"), "fake-png");

      const result = renameApp(homePath, "todo", "Task List");
      expect(result.success).toBe(true);
      expect(existsSync(join(homePath, "system/icons/task-list.png"))).toBe(true);
      expect(existsSync(join(homePath, "system/icons/todo.png"))).toBe(false);
    });

    it("returns error when target slug already exists", () => {
      writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");
      writeFileSync(join(homePath, "apps/task-list.html"), "<html></html>");

      const result = renameApp(homePath, "todo", "Task List");
      expect(result.success).toBe(false);
      expect(result.error).toContain("already exists");
    });
  });

  describe("deleteApp", () => {
    it("deletes a single-file HTML app", () => {
      writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");
      writeFileSync(
        join(homePath, "apps/todo.matrix.md"),
        "---\nname: Todo\n---\n",
      );

      const result = deleteApp(homePath, "todo");
      expect(result.success).toBe(true);
      expect(existsSync(join(homePath, "apps/todo.html"))).toBe(false);
      expect(existsSync(join(homePath, "apps/todo.matrix.md"))).toBe(false);
    });

    it("deletes a directory-based app", () => {
      const dir = join(homePath, "apps/my-app");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), "<html></html>");
      writeFileSync(
        join(dir, "matrix.json"),
        JSON.stringify({ name: "My App", runtime: "static" }),
      );

      const result = deleteApp(homePath, "my-app");
      expect(result.success).toBe(true);
      expect(existsSync(dir)).toBe(false);
    });

    it("also deletes data directory", () => {
      writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");
      mkdirSync(join(homePath, "data/todo"), { recursive: true });
      writeFileSync(join(homePath, "data/todo/items.json"), "[]");

      const result = deleteApp(homePath, "todo");
      expect(result.success).toBe(true);
      expect(existsSync(join(homePath, "data/todo"))).toBe(false);
    });

    it("also deletes icon file", () => {
      writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");
      mkdirSync(join(homePath, "system/icons"), { recursive: true });
      writeFileSync(join(homePath, "system/icons/todo.png"), "fake-png");

      const result = deleteApp(homePath, "todo");
      expect(result.success).toBe(true);
      expect(existsSync(join(homePath, "system/icons/todo.png"))).toBe(false);
    });

    it("returns error for non-existent app", () => {
      const result = deleteApp(homePath, "nonexistent");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("returns error for invalid slug", () => {
      const result = deleteApp(homePath, "../etc/passwd");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid slug");
    });

    it("succeeds even when data dir and icon do not exist", () => {
      writeFileSync(join(homePath, "apps/simple.html"), "<html></html>");

      const result = deleteApp(homePath, "simple");
      expect(result.success).toBe(true);
      expect(existsSync(join(homePath, "apps/simple.html"))).toBe(false);
    });
  });
});
