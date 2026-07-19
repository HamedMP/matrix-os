import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getPersonaSuggestions } from "../../packages/kernel/src/onboarding.js";
import { generateIconsForApps } from "../../packages/gateway/src/provisioner.js";
import {
  resolveDefaultAppIconUrl,
  resolveExactSystemIconUrl,
  resolveSystemIconUrl,
} from "../../packages/gateway/src/default-icons.js";

const PERSONA_ROLES = [
  "student",
  "developer",
  "investor",
  "entrepreneur",
  "parent",
  "creative",
  "researcher",
  "general",
];

function appNameToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

describe("default app icons", () => {
  it("resolves shipped manifest icons for default apps", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-icons-"));
    try {
      await mkdir(join(homePath, "apps/notes"), { recursive: true });
      await mkdir(join(homePath, "system/icons"), { recursive: true });
      await writeFile(
        join(homePath, "apps/notes/matrix.json"),
        JSON.stringify({ name: "Notes", slug: "notes", icon: "notes" }),
      );
      await writeFile(join(homePath, "system/icons/notes.png"), "png");

      await expect(resolveDefaultAppIconUrl(homePath, "notes")).resolves.toBe("/files/system/icons/notes.png");
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("falls back to the shared game icon without generating a new asset", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-icons-"));
    try {
      await mkdir(join(homePath, "system/icons"), { recursive: true });
      await writeFile(join(homePath, "system/icons/game-center.png"), "png");

      await expect(resolveSystemIconUrl(homePath, "missing-game.png")).resolves.toBe("/files/system/icons/game-center.png");
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("can check exact shipped icons without accepting generic fallbacks", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-icons-"));
    try {
      await mkdir(join(homePath, "system/icons"), { recursive: true });
      await writeFile(join(homePath, "system/icons/game-center.png"), "png");
      await writeFile(join(homePath, "system/icons/study-planner.svg"), "svg");

      await expect(resolveExactSystemIconUrl(homePath, "study-planner")).resolves.toBe("/files/system/icons/study-planner.svg");
      await expect(resolveExactSystemIconUrl(homePath, "missing-app")).resolves.toBeNull();
      await expect(resolveSystemIconUrl(homePath, "missing-app.png")).resolves.toBe("/files/system/icons/game-center.png");
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("ships icons for every onboarding persona app so signup does not regenerate them per user", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const iconsRoot = join(repoRoot, "home/system/icons");
    const missing: string[] = [];

    for (const role of PERSONA_ROLES) {
      for (const app of getPersonaSuggestions(role).apps) {
        const slug = appNameToSlug(app.name);
        if (!existsSync(join(iconsRoot, `${slug}.png`)) && !existsSync(join(iconsRoot, `${slug}.svg`))) {
          missing.push(`${role}:${slug}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("does not call image generation when a provisioned app has a shipped SVG icon", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-icons-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await mkdir(join(homePath, "system/icons"), { recursive: true });
      await writeFile(join(homePath, "system/icons/study-planner.svg"), "svg");

      await generateIconsForApps(homePath, "gemini-key", ["Study Planner"]);

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
