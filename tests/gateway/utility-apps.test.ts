import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppManifest } from "../../packages/gateway/src/app-manifest.js";

const APPS_DIR = join(__dirname, "../../home/apps");
const SHARED_RENDERER = join(__dirname, "../../home/apps/_shared/default-apps.tsx");

const UTILITY_APPS = [
  { slug: "calculator", name: "Calculator", category: "utility" },
  { slug: "clock", name: "Clock", category: "utility" },
];

function expectViteApp(appDir: string, appId: string) {
  const html = readFileSync(join(appDir, "index.html"), "utf-8");
  expect(html.toLowerCase()).toContain("<!doctype html>");
  expect(html).toContain('id="root"');
  expect(html).toContain('type="module"');
  expect(html).toContain("/src/main.tsx");
  expect(existsSync(join(appDir, "vite.config.ts"))).toBe(true);

  const source = readFileSync(join(appDir, "src/main.tsx"), "utf-8");
  expect(source).toContain("renderDefaultApp");
  expect(source).toContain(`"${appId}"`);
}

describe("T1430-T1433: Core utility apps", () => {
  for (const app of UTILITY_APPS) {
    describe(app.slug, () => {
      const appDir = join(APPS_DIR, app.slug);

      it("has a directory", () => {
        expect(existsSync(appDir)).toBe(true);
      });

      it("has a valid matrix.json", () => {
        const path = join(appDir, "matrix.json");
        expect(existsSync(path)).toBe(true);
        const manifest = JSON.parse(readFileSync(path, "utf-8"));
        const parsed = parseAppManifest(manifest);
        expect(parsed.name).toBe(app.name);
        expect(parsed.category).toBe(app.category);
        expect(parsed.runtime).toBe("vite");
        expect(manifest.build.command).toContain("vite build");
        expect(manifest.build.output).toBe("dist");
      });

      it("is a Vite app wired to the shared renderer", () => {
        expectViteApp(appDir, app.slug);
      });
    });
  }

  describe("calculator specifics", () => {
    const shared = () => readFileSync(SHARED_RENDERER, "utf-8");

    it("ships a scientific keypad and compact history", () => {
      expect(shared().toLowerCase()).toContain("scientific");
      expect(shared().toLowerCase()).toContain("history");
    });

    it("has calculator operations", () => {
      expect(shared()).toContain("÷");
      expect(shared()).toContain("×");
      expect(shared()).toContain("sqrt(144)");
    });
  });

  describe("clock specifics", () => {
    const shared = () => readFileSync(SHARED_RENDERER, "utf-8");

    it("has local time and focus timer surfaces", () => {
      expect(shared().toLowerCase()).toContain("time-card");
      expect(shared()).toContain("Local time");
      expect(shared().toLowerCase()).toContain("focus timer");
    });

    it("has timer functionality", () => {
      expect(shared().toLowerCase()).toContain("timer");
      expect(shared()).toContain("25:00");
    });
  });
});
