import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { discoverPlugins } from "../../packages/gateway/src/plugins/loader.js";
import { validateManifest, safeValidateManifest } from "../../packages/gateway/src/plugins/manifest.js";

describe("T930a: Plugin loader", () => {
  let homePath: string;
  let projectRoot: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "plugin-loader-")));
    projectRoot = resolve(mkdtempSync(join(tmpdir(), "plugin-project-")));
    mkdirSync(join(homePath, "plugins"), { recursive: true });
    mkdirSync(join(projectRoot, "packages"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe("manifest validation", () => {
    it("validates a valid manifest", () => {
      const manifest = validateManifest({
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        configSchema: {},
      });
      expect(manifest.id).toBe("test-plugin");
      expect(manifest.name).toBe("Test Plugin");
    });

    it("rejects manifest missing id", () => {
      const result = safeValidateManifest({ configSchema: {} });
      expect(result.success).toBe(false);
    });

    it("provides default configSchema when missing", () => {
      const manifest = validateManifest({ id: "minimal" });
      expect(manifest.configSchema).toEqual({});
    });

    it("accepts manifest with channels and skills", () => {
      const manifest = validateManifest({
        id: "full",
        channels: ["my-channel"],
        skills: ["my-skill.md"],
        configSchema: { type: "object" },
      });
      expect(manifest.channels).toEqual(["my-channel"]);
      expect(manifest.skills).toEqual(["my-skill.md"]);
    });

    it("rejects empty id", () => {
      const result = safeValidateManifest({ id: "", configSchema: {} });
      expect(result.success).toBe(false);
    });
  });

  describe("discovery", () => {
    it("discovers plugin from workspace path", () => {
      const pluginDir = join(homePath, "plugins", "my-plugin");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(pluginDir, "matrixos.plugin.json"),
        JSON.stringify({ id: "my-plugin", configSchema: {} }),
      );
      writeFileSync(join(pluginDir, "index.js"), "module.exports = { register() {} }");

      const plugins = discoverPlugins({ homePath });
      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.id).toBe("my-plugin");
      expect(plugins[0].origin).toBe("workspace");
    });

    it("discovers bundled plugins from packages/", () => {
      const pkgDir = join(projectRoot, "packages", "bundled-plugin");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "matrixos.plugin.json"),
        JSON.stringify({ id: "bundled-plugin", configSchema: {} }),
      );

      const plugins = discoverPlugins({ homePath, projectRoot });
      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.id).toBe("bundled-plugin");
      expect(plugins[0].origin).toBe("bundled");
    });

    it("returns discovery results with origin tag", () => {
      const wsDir = join(homePath, "plugins", "ws-plugin");
      mkdirSync(wsDir, { recursive: true });
      writeFileSync(
        join(wsDir, "matrixos.plugin.json"),
        JSON.stringify({ id: "ws-plugin", configSchema: {} }),
      );

      const pkgDir = join(projectRoot, "packages", "bundled-one");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "matrixos.plugin.json"),
        JSON.stringify({ id: "bundled-one", configSchema: {} }),
      );

      const plugins = discoverPlugins({ homePath, projectRoot });
      expect(plugins).toHaveLength(2);

      const bundled = plugins.find((p) => p.origin === "bundled");
      const workspace = plugins.find((p) => p.origin === "workspace");
      expect(bundled).toBeDefined();
      expect(workspace).toBeDefined();
    });

    it("deduplicates by id (first wins)", () => {
      const pkgDir = join(projectRoot, "packages", "dup-plugin");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "matrixos.plugin.json"),
        JSON.stringify({ id: "dup-plugin", configSchema: {} }),
      );

      const wsDir = join(homePath, "plugins", "dup-plugin");
      mkdirSync(wsDir, { recursive: true });
      writeFileSync(
        join(wsDir, "matrixos.plugin.json"),
        JSON.stringify({ id: "dup-plugin", configSchema: {} }),
      );

      const plugins = discoverPlugins({ homePath, projectRoot });
      expect(plugins).toHaveLength(1);
      expect(plugins[0].origin).toBe("bundled");
    });

    it("discovers config-origin plugins", () => {
      const configDir = resolve(mkdtempSync(join(tmpdir(), "config-plugin-")));
      writeFileSync(
        join(configDir, "matrixos.plugin.json"),
        JSON.stringify({ id: "config-plugin", configSchema: {} }),
      );

      const plugins = discoverPlugins({ homePath, configPaths: [configDir] });
      expect(plugins).toHaveLength(1);
      expect(plugins[0].origin).toBe("config");

      rmSync(configDir, { recursive: true, force: true });
    });

    it("skips invalid manifests", () => {
      const pluginDir = join(homePath, "plugins", "bad-plugin");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(pluginDir, "matrixos.plugin.json"),
        "not json",
      );

      const plugins = discoverPlugins({ homePath });
      expect(plugins).toHaveLength(0);
    });

    it("returns empty when no plugins exist", () => {
      const plugins = discoverPlugins({ homePath });
      expect(plugins).toHaveLength(0);
    });
  });
});
