import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { listApps } from "../../packages/gateway/src/apps.js";

describe("T711: GET /api/apps", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "apps-test-")));
    mkdirSync(join(homePath, "apps"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("returns empty array when no apps exist", () => {
    const apps = listApps(homePath);
    expect(apps).toEqual([]);
  });

  it("lists HTML apps with metadata from matrix.md", () => {
    writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");
    writeFileSync(
      join(homePath, "apps/todo.matrix.md"),
      "---\nname: Todo\ndescription: Task manager\ncategory: productivity\nicon: check\n---\n",
    );

    const apps = listApps(homePath);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toEqual({
      name: "Todo",
      description: "Task manager",
      category: "productivity",
      icon: "check",
      file: "todo.html",
      path: "/files/apps/todo.html",
    });
  });

  it("lists multiple apps sorted by name", () => {
    writeFileSync(join(homePath, "apps/notes.html"), "<html></html>");
    writeFileSync(join(homePath, "apps/notes.matrix.md"), "---\nname: Notes\ncategory: productivity\n---\n");
    writeFileSync(join(homePath, "apps/calc.html"), "<html></html>");
    writeFileSync(join(homePath, "apps/calc.matrix.md"), "---\nname: Calculator\ncategory: utility\n---\n");

    const apps = listApps(homePath);
    expect(apps).toHaveLength(2);
    expect(apps[0].name).toBe("Calculator");
    expect(apps[1].name).toBe("Notes");
  });

  it("uses defaults when matrix.md is missing", () => {
    writeFileSync(join(homePath, "apps/widget.html"), "<html></html>");

    const apps = listApps(homePath);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("widget");
    expect(apps[0].category).toBe("utility");
    expect(apps[0].path).toBe("/files/apps/widget.html");
  });

  it("ignores non-HTML files", () => {
    writeFileSync(join(homePath, "apps/readme.md"), "# readme");
    writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");

    const apps = listApps(homePath);
    expect(apps).toHaveLength(1);
    expect(apps[0].file).toBe("todo.html");
  });

  it("returns empty when apps directory does not exist", () => {
    rmSync(join(homePath, "apps"), { recursive: true, force: true });
    const apps = listApps(homePath);
    expect(apps).toEqual([]);
  });
});
