import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  detectAppType,
  createReactScaffold,
  registerModule,
  type ModuleEntry,
} from "../../packages/kernel/src/build-pipeline.js";

describe("T1320-T1323: Build pipeline", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "build-pipeline-")));
    mkdirSync(join(homePath, "modules"), { recursive: true });
    mkdirSync(join(homePath, "apps"), { recursive: true });
    mkdirSync(join(homePath, "system"), { recursive: true });
    writeFileSync(join(homePath, "system", "modules.json"), "[]");
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("detectAppType", () => {
    it("returns html for simple keywords", () => {
      expect(detectAppType("build me a quick calculator")).toBe("html");
      expect(detectAppType("make a simple clock")).toBe("html");
      expect(detectAppType("just a timer")).toBe("html");
    });

    it("returns react for complex requests", () => {
      expect(detectAppType("build me a project management app")).toBe("react");
      expect(detectAppType("create a dashboard with charts")).toBe("react");
      expect(detectAppType("make a multi-page app")).toBe("react");
    });

    it("returns react by default", () => {
      expect(detectAppType("build me an app")).toBe("react");
      expect(detectAppType("create something")).toBe("react");
    });

    it("returns html for known simple app types", () => {
      expect(detectAppType("calculator")).toBe("html");
      expect(detectAppType("clock")).toBe("html");
      expect(detectAppType("stopwatch")).toBe("html");
      expect(detectAppType("unit converter")).toBe("html");
    });
  });

  describe("createReactScaffold", () => {
    it("creates all scaffold files", () => {
      const modulePath = join(homePath, "modules", "test-app");
      createReactScaffold(modulePath, {
        name: "test-app",
        title: "Test App",
        description: "A test application",
      });

      expect(existsSync(join(modulePath, "package.json"))).toBe(true);
      expect(existsSync(join(modulePath, "vite.config.ts"))).toBe(true);
      expect(existsSync(join(modulePath, "tsconfig.json"))).toBe(true);
      expect(existsSync(join(modulePath, "index.html"))).toBe(true);
      expect(existsSync(join(modulePath, "module.json"))).toBe(true);
      expect(existsSync(join(modulePath, "src", "main.tsx"))).toBe(true);
      expect(existsSync(join(modulePath, "src", "App.tsx"))).toBe(true);
      expect(existsSync(join(modulePath, "src", "App.css"))).toBe(true);
    });

    it("sets correct app name in package.json", () => {
      const modulePath = join(homePath, "modules", "my-app");
      createReactScaffold(modulePath, {
        name: "my-app",
        title: "My App",
        description: "Test",
      });

      const pkg = JSON.parse(readFileSync(join(modulePath, "package.json"), "utf-8"));
      expect(pkg.name).toBe("@matrixos/my-app");
      expect(pkg.private).toBe(true);
      expect(pkg.dependencies.react).toBeDefined();
    });

    it("sets correct title in index.html", () => {
      const modulePath = join(homePath, "modules", "titled");
      createReactScaffold(modulePath, {
        name: "titled",
        title: "Custom Title",
        description: "Test",
      });

      const html = readFileSync(join(modulePath, "index.html"), "utf-8");
      expect(html).toContain("Custom Title");
    });

    it("sets correct vite base path", () => {
      const modulePath = join(homePath, "modules", "base");
      createReactScaffold(modulePath, {
        name: "base",
        title: "Base",
        description: "Test",
      });

      const config = readFileSync(join(modulePath, "vite.config.ts"), "utf-8");
      expect(config).toContain('base: "./"');
    });

    it("includes theme variables in App.css", () => {
      const modulePath = join(homePath, "modules", "themed");
      createReactScaffold(modulePath, {
        name: "themed",
        title: "Themed",
        description: "Test",
      });

      const css = readFileSync(join(modulePath, "src", "App.css"), "utf-8");
      expect(css).toContain("--bg");
      expect(css).toContain("--fg");
      expect(css).toContain("--accent");
      expect(css).toContain("--surface");
      expect(css).toContain("--border");
    });
  });

  describe("registerModule", () => {
    it("adds module entry to modules.json", () => {
      registerModule(homePath, {
        name: "new-app",
        type: "react-app",
        path: "~/modules/new-app",
        status: "active",
      });

      const modules = JSON.parse(readFileSync(join(homePath, "system", "modules.json"), "utf-8"));
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe("new-app");
      expect(modules[0].type).toBe("react-app");
    });

    it("appends to existing modules", () => {
      writeFileSync(
        join(homePath, "system", "modules.json"),
        JSON.stringify([{ name: "existing", type: "html-app", path: "~/apps/existing.html", status: "active" }]),
      );

      registerModule(homePath, {
        name: "second",
        type: "react-app",
        path: "~/modules/second",
        status: "active",
      });

      const modules = JSON.parse(readFileSync(join(homePath, "system", "modules.json"), "utf-8"));
      expect(modules).toHaveLength(2);
    });

    it("updates existing module by name", () => {
      registerModule(homePath, {
        name: "updatable",
        type: "html-app",
        path: "~/apps/updatable.html",
        status: "active",
      });

      registerModule(homePath, {
        name: "updatable",
        type: "react-app",
        path: "~/modules/updatable",
        status: "active",
      });

      const modules = JSON.parse(readFileSync(join(homePath, "system", "modules.json"), "utf-8"));
      expect(modules).toHaveLength(1);
      expect(modules[0].type).toBe("react-app");
    });

    it("creates modules.json if missing", () => {
      rmSync(join(homePath, "system", "modules.json"));
      registerModule(homePath, {
        name: "fresh",
        type: "html-app",
        path: "~/apps/fresh.html",
        status: "active",
      });

      expect(existsSync(join(homePath, "system", "modules.json"))).toBe(true);
      const modules = JSON.parse(readFileSync(join(homePath, "system", "modules.json"), "utf-8"));
      expect(modules).toHaveLength(1);
    });
  });
});
