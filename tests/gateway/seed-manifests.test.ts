import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { AppManifestSchema } from "../../packages/gateway/src/app-runtime/manifest-schema.js";

// Seed apps under home/apps/ get copied into every new user's home by
// distro/docker-entrypoint.sh on first boot. If any manifest fails to parse,
// the app's /api/apps/:slug/session endpoint returns 500 and the iframe
// stays stuck on "Refreshing session..." for every new user. This test
// catches that class of regression at CI time.

const SEED_APPS_DIR = join(process.cwd(), "home/apps");

function listAppDirs(): string[] {
  return readdirSync(SEED_APPS_DIR)
    .map((name) => join(SEED_APPS_DIR, name))
    .filter((path) => {
      try { return statSync(path).isDirectory(); } catch { return false; }
    });
}

describe("home/apps seed manifests", () => {
  const appDirs = listAppDirs();

  it("discovers at least one seed app", () => {
    expect(appDirs.length).toBeGreaterThan(0);
  });

  for (const appDir of appDirs) {
    const dirName = basename(appDir);
    const manifestPath = join(appDir, "matrix.json");
    let rawJson: string | null = null;
    try {
      rawJson = readFileSync(manifestPath, "utf8");
    } catch {
      // No manifest: skip silently; not every seed dir is a launchable app
      // (e.g. .gitkeep-only dirs or future scaffolding).
      continue;
    }

    // Templates (`_template-*`) are copied into new projects by skills,
    // not launched directly. They can carry an invalid-on-disk slug
    // (e.g. `_template-vite`) because the skill rewrites it during copy.
    const isTemplate = dirName.startsWith("_template-");

    describe(dirName, () => {
      if (isTemplate) {
        it.skip("is a template, skipped (copied by build-*-app skills, not launched)", () => {});
        return;
      }

      it("parses against AppManifestSchema", () => {
        const parsed = JSON.parse(rawJson!);
        const result = AppManifestSchema.safeParse(parsed);
        if (!result.success) {
          throw new Error(
            `${manifestPath}: ${result.error.message}`,
          );
        }
      });

      it("slug matches directory name", () => {
        const parsed = JSON.parse(rawJson!);
        expect(parsed.slug).toBe(dirName);
      });
    });
  }
});
