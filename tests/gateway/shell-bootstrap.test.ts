import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildShellBootstrap } from "../../packages/gateway/src/shell-bootstrap.js";

describe("shell bootstrap", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "shell-bootstrap-"));
    await mkdir(join(homePath, "system/icons"), { recursive: true });
    await mkdir(join(homePath, "apps/notes"), { recursive: true });
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
  });

  it("returns layout, modules, apps, and versioned icon URLs", async () => {
    await writeFile(join(homePath, "system/layout.json"), JSON.stringify({
      windows: [{ path: "__terminal__", title: "Terminal", x: 0, y: 0, width: 640, height: 480, state: "open" }],
    }));
    await writeFile(join(homePath, "system/modules.json"), JSON.stringify([
      { name: "Worker", path: "apps/worker", status: "active" },
    ]));
    await writeFile(join(homePath, "system/icons/terminal.png"), "terminal");
    await writeFile(join(homePath, "system/icons/notes.png"), "notes");
    await writeFile(join(homePath, "apps/notes/index.html"), "<html></html>");
    await writeFile(join(homePath, "apps/notes/matrix.json"), JSON.stringify({
      name: "Notes",
      slug: "notes",
      icon: "notes",
      version: "1.0.0",
      runtimeVersion: "^1.0.0",
      runtime: "static",
    }));

    const bootstrap = await buildShellBootstrap(homePath);

    expect(bootstrap.layout.windows).toHaveLength(1);
    expect(bootstrap.modules).toEqual([{ name: "Worker", path: "apps/worker", status: "active" }]);
    expect(bootstrap.apps.map((app) => app.name)).toEqual(["Notes"]);
    expect(bootstrap.icons.terminal.versionedUrl).toMatch(/^\/icons\/terminal\.png\?v=/);
    expect(bootstrap.icons.notes.versionedUrl).toMatch(/^\/icons\/notes\.png\?v=/);
    expect(bootstrap.icons.notes.etag).toMatch(/^".+"$/);
  });

  it("uses safe empty defaults when layout and modules are missing", async () => {
    await writeFile(join(homePath, "system/icons/game-center.png"), "fallback");

    const bootstrap = await buildShellBootstrap(homePath);

    expect(bootstrap.layout).toEqual({});
    expect(bootstrap.modules).toEqual([]);
    expect(bootstrap.apps).toEqual([]);
  });

  it("uses existing icon fallback resolution for missing app icons", async () => {
    await writeFile(join(homePath, "system/icons/game-center.png"), "fallback");
    await writeFile(join(homePath, "apps/notes/index.html"), "<html></html>");
    await writeFile(join(homePath, "apps/notes/matrix.json"), JSON.stringify({
      name: "Notes",
      slug: "notes",
      icon: "notes",
      version: "1.0.0",
      runtimeVersion: "^1.0.0",
      runtime: "static",
    }));

    const bootstrap = await buildShellBootstrap(homePath);

    expect(bootstrap.icons.notes.url).toBe("/icons/game-center.png");
    expect(bootstrap.icons.notes.versionedUrl).toMatch(/^\/icons\/game-center\.png\?v=/);
  });
});
