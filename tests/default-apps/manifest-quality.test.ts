import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Spec 083 quality gates: every shipped default app must be a real, icon-backed
// Vite app, and the durable-data apps must declare Postgres-backed storage so a
// fresh user / VPS restore boots with deterministic, persistent apps.

const REPO_ROOT = join(__dirname, "..", "..");
const APPS_DIR = join(REPO_ROOT, "home", "apps");
const ICONS_DIR = join(REPO_ROOT, "home", "system", "icons");

// Apps whose current runtime already depends on durable structured data living
// in owner-controlled Postgres (per spec 083). Newly migrated apps should add
// themselves here in the same PR that declares storage.tables.
const DURABLE_DATA_APPS = new Set(["notes", "todo", "expense-tracker"]);

interface Manifest {
  slug?: string;
  runtime?: string;
  icon?: string;
  build?: { output?: string };
  storage?: { tables?: Record<string, unknown> };
}

function appManifestDirs(root = APPS_DIR): string[] {
  const dirs: string[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith("_") || name === "node_modules" || name === "dist") continue;
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, "matrix.json"))) dirs.push(dir);
    dirs.push(...appManifestDirs(dir));
  }
  return dirs;
}

function appIdForDir(dir: string): string {
  return dir.replace(`${APPS_DIR}/`, "");
}

function iconExists(iconSlug: string): boolean {
  return (
    existsSync(join(ICONS_DIR, `${iconSlug}.svg`)) ||
    existsSync(join(ICONS_DIR, `${iconSlug}.png`))
  );
}

describe("default app manifest quality (spec 083)", () => {
  const dirs = appManifestDirs();

  it("discovers the default apps", () => {
    expect(dirs.length).toBeGreaterThan(5);
  });

  for (const dir of dirs) {
    const appId = appIdForDir(dir);
    describe(appId, () => {
      const manifest: Manifest = JSON.parse(
        readFileSync(join(dir, "matrix.json"), "utf-8"),
      );

      it("is a vite app that builds to dist", () => {
        expect(manifest.runtime).toBe("vite");
        expect(manifest.build?.output ?? "dist").toBe("dist");
      });

      it("declares a slug matching its directory", () => {
        expect(manifest.slug).toBeTruthy();
        expect(appId.endsWith(manifest.slug as string)).toBe(true);
      });

      it("has an icon slug backed by a shipped icon asset", () => {
        expect(manifest.icon, `${dir} must declare an icon`).toBeTruthy();
        expect(
          iconExists(manifest.icon as string),
          `${dir} icon "${manifest.icon}" needs home/system/icons/${manifest.icon}.svg|png`,
        ).toBe(true);
      });

      if (DURABLE_DATA_APPS.has(manifest.slug ?? appId)) {
        it("declares Postgres-backed storage tables", () => {
          const tables = manifest.storage?.tables ?? {};
          expect(Object.keys(tables).length).toBeGreaterThan(0);
        });
      }
    });
  }
});
