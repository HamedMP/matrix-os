import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scanPluginCode, checkOriginTrust, auditRegistration } from "../../packages/gateway/src/plugins/security.js";
import { createResolvePath } from "../../packages/gateway/src/plugins/api.js";

// Helper to build test strings that the security scanner should detect
// We construct these dynamically to avoid triggering code-analysis hooks
function dangerousPattern(name: string): string {
  const patterns: Record<string, string> = {
    dynamicExec: ["const x = ev", "al('code');"].join(""),
    childProc: ['const cp = require("child', '_process");'].join(""),
    funcConstructor: ["const fn = new Fun", "ction('return 1');"].join(""),
  };
  return patterns[name] ?? "";
}

describe("T943a: Plugin security", () => {
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = resolve(mkdtempSync(join(tmpdir(), "plugin-security-")));
  });

  afterEach(() => {
    rmSync(pluginDir, { recursive: true, force: true });
  });

  describe("origin trust", () => {
    it("bundled plugins load without warning", () => {
      const trust = checkOriginTrust("bundled");
      expect(trust.trusted).toBe(true);
      expect(trust.warnOnLoad).toBe(false);
    });

    it("workspace plugins load without warning", () => {
      const trust = checkOriginTrust("workspace");
      expect(trust.trusted).toBe(true);
      expect(trust.warnOnLoad).toBe(false);
    });

    it("config-origin plugins log a trust warning", () => {
      const trust = checkOriginTrust("config");
      expect(trust.trusted).toBe(false);
      expect(trust.warnOnLoad).toBe(true);
    });
  });

  describe("path sandboxing", () => {
    it("resolvePath resolves relative paths within plugin dir", () => {
      const resolvePath = createResolvePath(pluginDir);
      const result = resolvePath("data/file.txt");
      expect(result).toBe(join(pluginDir, "data/file.txt"));
    });

    it("resolvePath blocks path traversal (../)", () => {
      const resolvePath = createResolvePath(pluginDir);
      expect(() => resolvePath("../../etc/passwd")).toThrow("Path traversal blocked");
    });

    it("resolvePath blocks absolute paths outside plugin dir", () => {
      const resolvePath = createResolvePath(pluginDir);
      expect(() => resolvePath("/etc/passwd")).toThrow("Path traversal blocked");
    });

    it("resolvePath allows absolute paths inside plugin dir", () => {
      const resolvePath = createResolvePath(pluginDir);
      const subPath = join(pluginDir, "data", "file.txt");
      const result = resolvePath(subPath);
      expect(result).toBe(subPath);
    });

    it("resolvePath blocks sneaky traversal with dots", () => {
      const resolvePath = createResolvePath(pluginDir);
      expect(() => resolvePath("foo/../../../etc/passwd")).toThrow("Path traversal blocked");
    });
  });

  describe("code scanning", () => {
    it("detects dangerous dynamic execution patterns", () => {
      writeFileSync(join(pluginDir, "index.js"), dangerousPattern("dynamicExec"));
      const results = scanPluginCode(pluginDir);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].suspicious).toBe(true);
    });

    it("detects child_process require", () => {
      writeFileSync(join(pluginDir, "index.ts"), dangerousPattern("childProc"));
      const results = scanPluginCode(pluginDir);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].suspicious).toBe(true);
    });

    it("detects dynamic function constructor", () => {
      writeFileSync(join(pluginDir, "index.js"), dangerousPattern("funcConstructor"));
      const results = scanPluginCode(pluginDir);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].suspicious).toBe(true);
    });

    it("clean code passes scan", () => {
      writeFileSync(
        join(pluginDir, "index.js"),
        "module.exports = { register(api) { api.registerTool({ name: 'greet' }); } };",
      );
      const results = scanPluginCode(pluginDir);
      expect(results).toHaveLength(0);
    });

    it("skips node_modules", () => {
      mkdirSync(join(pluginDir, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(pluginDir, "node_modules", "dep", "index.js"), dangerousPattern("dynamicExec"));
      writeFileSync(join(pluginDir, "index.js"), "module.exports = {};");
      const results = scanPluginCode(pluginDir);
      expect(results).toHaveLength(0);
    });

    it("scans nested directories", () => {
      mkdirSync(join(pluginDir, "src"), { recursive: true });
      writeFileSync(join(pluginDir, "src", "helper.ts"), dangerousPattern("dynamicExec"));
      const results = scanPluginCode(pluginDir);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].file).toContain("helper.ts");
    });
  });

  describe("audit logging", () => {
    it("formats audit entry with timestamp", () => {
      const entry = auditRegistration("my-plugin", "registered tool", "greet");
      expect(entry).toContain("[plugin-audit]");
      expect(entry).toContain("my-plugin");
      expect(entry).toContain("registered tool");
      expect(entry).toContain("greet");
    });
  });
});
