import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Spec 083 quality gates: every shipped default app must be a real, icon-backed
// Vite app, and the durable-data apps must declare Postgres-backed storage so a
// fresh user / VPS restore boots with deterministic, persistent apps.

const REPO_ROOT = join(__dirname, "..", "..");
const APPS_DIR = join(REPO_ROOT, "home", "apps");
const ICONS_DIR = join(REPO_ROOT, "home", "system", "icons");

// Apps whose product value depends on durable structured data living in
// owner-controlled Postgres (per spec 083). These must declare storage.tables.
const DURABLE_DATA_APPS = new Set(["notes", "task-manager", "todo", "expense-tracker"]);

interface Manifest {
  slug?: string;
  runtime?: string;
  icon?: string;
  build?: { output?: string };
  storage?: { tables?: Record<string, unknown> };
}

function appDirs(): string[] {
  return readdirSync(APPS_DIR)
    .filter((name) => !name.startsWith("_"))
    .filter((name) => {
      const dir = join(APPS_DIR, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "matrix.json"));
    });
}

function iconExists(iconSlug: string): boolean {
  return (
    existsSync(join(ICONS_DIR, `${iconSlug}.svg`)) ||
    existsSync(join(ICONS_DIR, `${iconSlug}.png`))
  );
}

describe("default app manifest quality (spec 083)", () => {
  const dirs = appDirs();

  it("discovers the default apps", () => {
    expect(dirs.length).toBeGreaterThan(5);
  });

  for (const dir of dirs) {
    describe(dir, () => {
      const manifest: Manifest = JSON.parse(
        readFileSync(join(APPS_DIR, dir, "matrix.json"), "utf-8"),
      );

      it("is a vite app that builds to dist", () => {
        expect(manifest.runtime).toBe("vite");
        expect(manifest.build?.output ?? "dist").toBe("dist");
      });

      it("declares a slug matching its directory", () => {
        expect(manifest.slug ?? dir).toBe(dir);
      });

      it("has an icon slug backed by a shipped icon asset", () => {
        expect(manifest.icon, `${dir} must declare an icon`).toBeTruthy();
        expect(
          iconExists(manifest.icon as string),
          `${dir} icon "${manifest.icon}" needs home/system/icons/${manifest.icon}.svg|png`,
        ).toBe(true);
      });

      if (DURABLE_DATA_APPS.has(dir)) {
        it("declares Postgres-backed storage tables", () => {
          const tables = manifest.storage?.tables ?? {};
          expect(Object.keys(tables).length).toBeGreaterThan(0);
        });
      }
    });
  }
});
