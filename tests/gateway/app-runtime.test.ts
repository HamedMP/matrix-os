import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("T1400: App Runtime", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "app-runtime-test-")));
    mkdirSync(join(homePath, "apps"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("matrix.json manifest schema", () => {
    let parseAppManifest: typeof import("../../packages/gateway/src/app-manifest.js").parseAppManifest;
    let loadAppManifest: typeof import("../../packages/gateway/src/app-manifest.js").loadAppManifest;
    let assignPort: typeof import("../../packages/gateway/src/app-manifest.js").assignPort;
    let AppManifestSchema: typeof import("../../packages/gateway/src/app-manifest.js").AppManifestSchema;

    beforeEach(async () => {
      const mod = await import("../../packages/gateway/src/app-manifest.js");
      parseAppManifest = mod.parseAppManifest;
      loadAppManifest = mod.loadAppManifest;
      assignPort = mod.assignPort;
      AppManifestSchema = mod.AppManifestSchema;
    });

    it("parses a valid matrix.json with all fields", () => {
      const manifest = parseAppManifest({
        name: "My Dashboard",
        description: "A cool dashboard",
        runtime: "node",
        entry: "pnpm dev",
        port: 3100,
        framework: "nextjs",
        permissions: ["network", "database"],
        resources: { memory: "256MB", cpu: 0.5 },
        category: "productivity",
        icon: "dashboard",
        author: "system",
        version: "1.0.0",
      });

      expect(manifest.name).toBe("My Dashboard");
      expect(manifest.runtime).toBe("node");
      expect(manifest.entry).toBe("pnpm dev");
      expect(manifest.port).toBe(3100);
      expect(manifest.framework).toBe("nextjs");
      expect(manifest.permissions).toEqual(["network", "database"]);
      expect(manifest.resources).toEqual({ memory: "256MB", cpu: 0.5 });
    });

    it("defaults runtime to 'static' when not specified", () => {
      const manifest = parseAppManifest({ name: "Simple App" });
      expect(manifest.runtime).toBe("static");
    });

    it("defaults category to 'utility' when not specified", () => {
      const manifest = parseAppManifest({ name: "Test" });
      expect(manifest.category).toBe("utility");
    });

    it("validates runtime enum values", () => {
      expect(() => parseAppManifest({ name: "Bad", runtime: "invalid" as any })).toThrow();
    });

    it("validates port is within valid range", () => {
      expect(() => parseAppManifest({ name: "Bad", port: 80 })).toThrow();
      expect(() => parseAppManifest({ name: "Bad", port: 70000 })).toThrow();
    });

    it("accepts valid port range (1024-65535)", () => {
      const manifest = parseAppManifest({ name: "Ok", port: 3100 });
      expect(manifest.port).toBe(3100);
    });

    it("assigns auto port from range 3100-3999 when not specified", () => {
      const port = assignPort(new Set());
      expect(port).toBeGreaterThanOrEqual(3100);
      expect(port).toBeLessThanOrEqual(3999);
    });

    it("skips already-used ports", () => {
      const usedPorts = new Set([3100, 3101, 3102]);
      const port = assignPort(usedPorts);
      expect(port).toBe(3103);
    });

    it("throws when no ports available", () => {
      const allUsed = new Set<number>();
      for (let i = 3100; i <= 3999; i++) allUsed.add(i);
      expect(() => assignPort(allUsed)).toThrow("No available ports");
    });

    it("loads matrix.json from app directory", () => {
      const appDir = join(homePath, "apps", "dashboard");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, "matrix.json"),
        JSON.stringify({
          name: "Dashboard",
          runtime: "node",
          entry: "pnpm dev",
          port: 3100,
        }),
      );

      const manifest = loadAppManifest(appDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.name).toBe("Dashboard");
      expect(manifest!.runtime).toBe("node");
    });

    it("falls back to matrix.md when no matrix.json exists", () => {
      const appDir = join(homePath, "apps", "notes");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, "matrix.md"),
        `---
name: Notes
description: Markdown notes
category: productivity
icon: N
---`,
      );

      const manifest = loadAppManifest(appDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.name).toBe("Notes");
      expect(manifest!.category).toBe("productivity");
      expect(manifest!.runtime).toBe("static");
    });

    it("returns null for directory without manifest", () => {
      const appDir = join(homePath, "apps", "empty");
      mkdirSync(appDir, { recursive: true });

      const manifest = loadAppManifest(appDir);
      expect(manifest).toBeNull();
    });

    it("handles autoStart boolean field", () => {
      const manifest = parseAppManifest({
        name: "Worker",
        runtime: "node",
        autoStart: true,
      });
      expect(manifest.autoStart).toBe(true);
    });

    it("defaults autoStart to false", () => {
      const manifest = parseAppManifest({ name: "Lazy" });
      expect(manifest.autoStart).toBe(false);
    });
  });

  describe("App process manager", () => {
    let createAppManager: typeof import("../../packages/gateway/src/app-manager.js").createAppManager;

    beforeEach(async () => {
      const mod = await import("../../packages/gateway/src/app-manager.js");
      createAppManager = mod.createAppManager;
    });

    it("tracks running apps in memory", () => {
      const manager = createAppManager({ homePath });
      expect(manager.list()).toEqual([]);
    });

    it("registers a static app without spawning a process", async () => {
      const appDir = join(homePath, "apps", "simple");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, "index.html"), "<html></html>");
      writeFileSync(
        join(appDir, "matrix.json"),
        JSON.stringify({ name: "Simple", runtime: "static" }),
      );

      const manager = createAppManager({ homePath });
      const status = await manager.register("simple");
      expect(status.name).toBe("Simple");
      expect(status.status).toBe("running");
      expect(status.runtime).toBe("static");
    });

    it("lists registered apps", async () => {
      const appDir = join(homePath, "apps", "app1");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, "matrix.json"),
        JSON.stringify({ name: "App 1", runtime: "static" }),
      );

      const manager = createAppManager({ homePath });
      await manager.register("app1");
      const apps = manager.list();
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe("App 1");
    });

    it("gets status of a specific app", async () => {
      const appDir = join(homePath, "apps", "myapp");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, "matrix.json"),
        JSON.stringify({ name: "My App", runtime: "static", category: "utility" }),
      );

      const manager = createAppManager({ homePath });
      await manager.register("myapp");
      const status = manager.get("myapp");
      expect(status).not.toBeNull();
      expect(status!.name).toBe("My App");
      expect(status!.status).toBe("running");
    });

    it("returns null for unknown app", () => {
      const manager = createAppManager({ homePath });
      expect(manager.get("nope")).toBeNull();
    });

    it("stops a static app (removes from registry)", async () => {
      const appDir = join(homePath, "apps", "rm");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, "matrix.json"),
        JSON.stringify({ name: "Remove Me", runtime: "static" }),
      );

      const manager = createAppManager({ homePath });
      await manager.register("rm");
      expect(manager.list()).toHaveLength(1);

      await manager.stop("rm");
      expect(manager.get("rm")?.status).toBe("stopped");
    });

    it("scans apps directory and auto-registers static apps", async () => {
      for (const name of ["a", "b"]) {
        const dir = join(homePath, "apps", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "matrix.json"),
          JSON.stringify({ name: name.toUpperCase(), runtime: "static" }),
        );
      }

      const manager = createAppManager({ homePath });
      await manager.scanAndRegister();
      expect(manager.list()).toHaveLength(2);
    });

    it("supports single-file apps (HTML in apps root)", async () => {
      writeFileSync(join(homePath, "apps", "calc.html"), "<html></html>");
      writeFileSync(
        join(homePath, "apps", "calc.matrix.md"),
        "---\nname: Calculator\ncategory: utility\n---\n",
      );

      const manager = createAppManager({ homePath });
      await manager.scanAndRegister();
      const apps = manager.list();
      expect(apps.some((a) => a.name === "Calculator")).toBe(true);
    });

    it("stops all apps on shutdown", async () => {
      const dir = join(homePath, "apps", "x");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "matrix.json"),
        JSON.stringify({ name: "X", runtime: "static" }),
      );

      const manager = createAppManager({ homePath });
      await manager.register("x");
      await manager.stopAll();
      expect(manager.list().every((a) => a.status === "stopped")).toBe(true);
    });
  });

  describe("Enhanced listApps with matrix.json support", () => {
    let listAppsEnhanced: typeof import("../../packages/gateway/src/apps.js").listApps;

    beforeEach(async () => {
      const mod = await import("../../packages/gateway/src/apps.js");
      listAppsEnhanced = mod.listApps;
    });

    it("lists directory-based apps with matrix.json", () => {
      const appDir = join(homePath, "apps", "dashboard");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, "index.html"), "<html></html>");
      writeFileSync(
        join(appDir, "matrix.json"),
        JSON.stringify({
          name: "Dashboard",
          description: "System dashboard",
          category: "utility",
          runtime: "static",
          icon: "chart",
        }),
      );

      const apps = listAppsEnhanced(homePath);
      expect(apps.some((a) => a.name === "Dashboard")).toBe(true);
    });

    it("lists both single-file and directory apps", () => {
      writeFileSync(join(homePath, "apps", "notes.html"), "<html></html>");
      writeFileSync(
        join(homePath, "apps", "notes.matrix.md"),
        "---\nname: Notes\ncategory: productivity\n---\n",
      );

      const dir = join(homePath, "apps", "dashboard");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), "<html></html>");
      writeFileSync(
        join(dir, "matrix.json"),
        JSON.stringify({ name: "Dashboard", category: "utility" }),
      );

      const apps = listAppsEnhanced(homePath);
      expect(apps.length).toBeGreaterThanOrEqual(2);
      expect(apps.some((a) => a.name === "Notes")).toBe(true);
      expect(apps.some((a) => a.name === "Dashboard")).toBe(true);
    });
  });
});
