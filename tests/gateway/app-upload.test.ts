import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleAppUpload, validateUploadManifest } from "../../packages/gateway/src/app-upload.js";

const TEST_HOME = join(tmpdir(), `matrix-upload-${Date.now()}`);
const APPS_DIR = join(TEST_HOME, "apps");

beforeEach(() => {
  mkdirSync(APPS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("T1460-T1463: App upload", () => {
  describe("validateUploadManifest", () => {
    it("accepts valid manifest", () => {
      const result = validateUploadManifest({
        name: "Test App",
        runtime: "static",
        category: "utility",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects manifest without name", () => {
      const result = validateUploadManifest({
        runtime: "static",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects invalid runtime", () => {
      const result = validateUploadManifest({
        name: "Test",
        runtime: "invalid-runtime",
      });
      expect(result.valid).toBe(false);
    });

    it("uses defaults for optional fields", () => {
      const result = validateUploadManifest({
        name: "Test",
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("handleAppUpload", () => {
    it("writes files to apps directory", () => {
      const result = handleAppUpload(TEST_HOME, "my-app", {
        "index.html": "<!DOCTYPE html><html><body>Hi</body></html>",
        "matrix.json": JSON.stringify({
          name: "My App",
          runtime: "static",
        }),
      });
      expect(result.success).toBe(true);
      expect(result.slug).toBe("my-app");
      expect(existsSync(join(APPS_DIR, "my-app", "index.html"))).toBe(true);
      expect(existsSync(join(APPS_DIR, "my-app", "matrix.json"))).toBe(true);
    });

    it("generates slug from name if not provided", () => {
      const result = handleAppUpload(TEST_HOME, undefined, {
        "matrix.json": JSON.stringify({
          name: "My Cool App",
          runtime: "static",
        }),
        "index.html": "<h1>Hello</h1>",
      });
      expect(result.success).toBe(true);
      expect(result.slug).toBe("my-cool-app");
    });

    it("rejects upload without any files", () => {
      const result = handleAppUpload(TEST_HOME, "empty", {});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no files/i);
    });

    it("rejects invalid manifest in uploaded files", () => {
      const result = handleAppUpload(TEST_HOME, "bad", {
        "matrix.json": "not json",
        "index.html": "<h1>Hi</h1>",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/manifest/i);
    });

    it("creates matrix.json if only HTML files provided", () => {
      const result = handleAppUpload(TEST_HOME, "simple-app", {
        "index.html": "<!DOCTYPE html><html><body>App</body></html>",
      });
      expect(result.success).toBe(true);
      const manifestPath = join(APPS_DIR, "simple-app", "matrix.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(manifest.name).toBe("simple-app");
      expect(manifest.runtime).toBe("static");
    });

    it("overwrites existing app directory", () => {
      mkdirSync(join(APPS_DIR, "existing"), { recursive: true });
      writeFileSync(join(APPS_DIR, "existing", "old.txt"), "old");

      const result = handleAppUpload(TEST_HOME, "existing", {
        "index.html": "<h1>New</h1>",
        "matrix.json": JSON.stringify({ name: "Existing", runtime: "static" }),
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(APPS_DIR, "existing", "old.txt"))).toBe(false);
      expect(existsSync(join(APPS_DIR, "existing", "index.html"))).toBe(true);
    });

    it("sanitizes slug to prevent path traversal", () => {
      const result = handleAppUpload(TEST_HOME, "../../../etc/passwd", {
        "index.html": "<h1>Bad</h1>",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid.*slug/i);
    });

    it("rejects slugs with special characters", () => {
      const result = handleAppUpload(TEST_HOME, "app with spaces!", {
        "index.html": "<h1>Hi</h1>",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid.*slug/i);
    });

    it("returns app URL on success", () => {
      const result = handleAppUpload(TEST_HOME, "my-app", {
        "index.html": "<h1>Hi</h1>",
        "matrix.json": JSON.stringify({ name: "My App", runtime: "static" }),
      });
      expect(result.success).toBe(true);
      expect(result.appUrl).toContain("my-app");
    });

    it("handles nested directory files", () => {
      const result = handleAppUpload(TEST_HOME, "nested-app", {
        "index.html": "<h1>Main</h1>",
        "matrix.json": JSON.stringify({ name: "Nested", runtime: "static" }),
        "assets/style.css": "body { color: red; }",
        "assets/images/logo.png": "fake-png-data",
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(APPS_DIR, "nested-app", "assets", "style.css"))).toBe(true);
      expect(existsSync(join(APPS_DIR, "nested-app", "assets", "images", "logo.png"))).toBe(true);
    });
  });
});
