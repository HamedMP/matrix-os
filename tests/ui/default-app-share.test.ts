import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isShareableAppSlug, MATRIX_DEFAULT_APP_SLUGS } from "@matrix-os/ui/share";

// User outcome: Share appears only on apps the owner built, never on the apps
// Matrix ships. Faults: a new default app added to home/apps without joining the
// list (Share reappears on it), or a custom app wrongly treated as default.

const HOME_APPS = join(import.meta.dirname, "../../home/apps");

async function shippedAppSlugs(dir = HOME_APPS): Promise<string[]> {
  const slugs: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const appDir = join(dir, entry.name);
    try {
      const manifest = JSON.parse(await readFile(join(appDir, "matrix.json"), "utf8")) as { slug?: string };
      slugs.push(manifest.slug ?? entry.name);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    slugs.push(...await shippedAppSlugs(appDir));
  }
  return slugs;
}

describe("Matrix default apps and Share", () => {
  it("lists exactly the apps shipped in the OS home template", async () => {
    expect([...MATRIX_DEFAULT_APP_SLUGS].sort()).toEqual([...new Set(await shippedAppSlugs())].sort());
  });

  it("hides Share for default apps, including nested games", () => {
    expect(isShareableAppSlug("calculator")).toBe(false);
    expect(isShareableAppSlug("notes")).toBe(false);
    expect(isShareableAppSlug("chess")).toBe(false);
  });

  it("keeps Share for apps the owner built", () => {
    expect(isShareableAppSlug("team-tracker")).toBe(true);
    expect(isShareableAppSlug("my-notes")).toBe(true);
  });
});
