import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppManifest } from "../../packages/gateway/src/app-manifest.js";

const APPS_DIR = join(__dirname, "../../home/apps");

const UTILITY_APPS = [
  { slug: "calculator", name: "Calculator", category: "utility" },
  { slug: "clock", name: "Clock", category: "utility" },
];

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
        expect(parsed.runtime).toBe("static");
      });

      it("has an index.html", () => {
        expect(existsSync(join(appDir, "index.html"))).toBe(true);
      });

      it("index.html is a complete page", () => {
        const html = readFileSync(join(appDir, "index.html"), "utf-8");
        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain("<title>");
        expect(html).toContain("<script>");
      });
    });
  }

  describe("calculator specifics", () => {
    it("supports basic and scientific modes", () => {
      const html = readFileSync(join(APPS_DIR, "calculator", "index.html"), "utf-8");
      expect(html).toContain("modeBasic");
      expect(html).toContain("modeSci");
    });

    it("supports keyboard input", () => {
      const html = readFileSync(join(APPS_DIR, "calculator", "index.html"), "utf-8");
      expect(html).toContain("keydown");
    });

    it("has scientific functions", () => {
      const html = readFileSync(join(APPS_DIR, "calculator", "index.html"), "utf-8");
      expect(html).toContain("Math.sin");
      expect(html).toContain("Math.cos");
      expect(html).toContain("Math.log");
    });
  });

  describe("clock specifics", () => {
    it("has analog and digital displays", () => {
      const html = readFileSync(join(APPS_DIR, "clock", "index.html"), "utf-8");
      expect(html).toContain("analog");
      expect(html).toContain("digital");
    });

    it("has stopwatch functionality", () => {
      const html = readFileSync(join(APPS_DIR, "clock", "index.html"), "utf-8");
      expect(html).toContain("timerStart");
      expect(html).toContain("timerLap");
      expect(html).toContain("timerReset");
    });

    it("displays timezone", () => {
      const html = readFileSync(join(APPS_DIR, "clock", "index.html"), "utf-8");
      expect(html).toContain("timeZone");
    });
  });
});
