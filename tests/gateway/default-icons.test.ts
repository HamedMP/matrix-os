import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDefaultAppIconUrl, resolveSystemIconUrl } from "../../packages/gateway/src/default-icons.js";

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
});
