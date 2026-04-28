import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAppManager, type AppManager } from "../../packages/gateway/src/app-manager.js";

describe("T1402: App lifecycle API", () => {
  let homePath: string;
  let manager: AppManager;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "app-api-test-")));
    mkdirSync(join(homePath, "apps"), { recursive: true });
    manager = createAppManager({ homePath });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("app scanning on boot", () => {
    it("scans ~/apps/ and auto-registers directory-based apps", async () => {
      for (const name of ["alpha", "beta"]) {
        const dir = join(homePath, "apps", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "index.html"), "<html></html>");
        writeFileSync(
          join(dir, "matrix.json"),
          JSON.stringify({ name: name.charAt(0).toUpperCase() + name.slice(1), runtime: "static" }),
        );
      }

      await manager.scanAndRegister();
      const apps = manager.list();
      expect(apps).toHaveLength(2);
      expect(apps.map((a) => a.name).sort()).toEqual(["Alpha", "Beta"]);
    });

    it("scans ~/apps/ and auto-registers single-file HTML apps", async () => {
      writeFileSync(join(homePath, "apps", "calc.html"), "<html></html>");
      writeFileSync(
        join(homePath, "apps", "calc.matrix.md"),
        "---\nname: Calculator\ncategory: utility\n---\n",
      );

      await manager.scanAndRegister();
      const apps = manager.list();
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe("Calculator");
    });

    it("skips directories without manifests", async () => {
      const dir = join(homePath, "apps", "empty-dir");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "random.txt"), "hi");

      await manager.scanAndRegister();
      expect(manager.list()).toHaveLength(0);
    });

    it("skips hidden directories", async () => {
      const dir = join(homePath, "apps", ".hidden");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "matrix.json"),
        JSON.stringify({ name: "Hidden", runtime: "static" }),
      );

      await manager.scanAndRegister();
      expect(manager.list()).toHaveLength(0);
    });
  });

  describe("start/stop lifecycle", () => {
    it("static apps are immediately 'running' on register", async () => {
      const dir = join(homePath, "apps", "sapp");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "matrix.json"),
        JSON.stringify({ name: "S", runtime: "static" }),
      );

      const status = await manager.register("sapp");
      expect(status.status).toBe("running");
    });

    it("non-static apps start as 'stopped'", async () => {
      const dir = join(homePath, "apps", "napp");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "matrix.json"),
        JSON.stringify({ name: "Node App", runtime: "node", entry: "node index.js", port: 3100 }),
      );

      const status = await manager.register("napp");
      expect(status.status).toBe("stopped");
    });

    it("registers Vite apps discovered from default app manifests", async () => {
      const dir = join(homePath, "apps", "whiteboard");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "matrix.json"),
        JSON.stringify({
          name: "Whiteboard",
          slug: "whiteboard",
          runtime: "vite",
          runtimeVersion: "^1.0.0",
          build: { command: "pnpm build", output: "dist" },
        }),
      );

      const status = await manager.register("whiteboard");
      expect(status.runtime).toBe("vite");
      expect(status.status).toBe("stopped");
    });

    it("stop changes status to stopped", async () => {
      const dir = join(homePath, "apps", "x");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "matrix.json"),
        JSON.stringify({ name: "X", runtime: "static" }),
      );

      await manager.register("x");
      expect(manager.get("x")!.status).toBe("running");

      await manager.stop("x");
      expect(manager.get("x")!.status).toBe("stopped");
    });

    it("stopAll stops all registered apps", async () => {
      for (const name of ["a", "b", "c"]) {
        const dir = join(homePath, "apps", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "matrix.json"),
          JSON.stringify({ name, runtime: "static" }),
        );
        await manager.register(name);
      }

      await manager.stopAll();
      for (const app of manager.list()) {
        expect(app.status).toBe("stopped");
      }
    });
  });

  describe("app paths", () => {
    it("directory app path points to slug/index.html", async () => {
      const dir = join(homePath, "apps", "dash");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), "<html></html>");
      writeFileSync(
        join(dir, "matrix.json"),
        JSON.stringify({ name: "Dash", runtime: "static" }),
      );

      const status = await manager.register("dash");
      expect(status.path).toBe("/files/apps/dash/index.html");
    });

    it("single-file app path points to slug.html", async () => {
      writeFileSync(join(homePath, "apps", "todo.html"), "<html></html>");
      writeFileSync(
        join(homePath, "apps", "todo.matrix.md"),
        "---\nname: Todo\ncategory: productivity\n---\n",
      );

      const status = await manager.register("todo");
      expect(status.path).toBe("/files/apps/todo.html");
    });
  });
});
