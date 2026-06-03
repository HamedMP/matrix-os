import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resetShippedIcons } from "../../scripts/reset-shipped-icons.mjs";

describe("reset-shipped-icons", () => {
  it("overwrites stale shipped icons and backs up changed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "reset-icons-"));
    try {
      const templateHome = join(root, "template");
      const matrixHome = join(root, "home");
      await mkdir(join(templateHome, "system/icons"), { recursive: true });
      await mkdir(join(matrixHome, "system/icons"), { recursive: true });
      await writeFile(join(templateHome, "system/icons/chess.png"), "new-chess", { flag: "wx" });
      await writeFile(join(templateHome, "system/icons/todo.svg"), "new-todo", { flag: "wx" });
      await writeFile(join(matrixHome, "system/icons/chess.png"), "old-chess", { flag: "wx" });
      await writeFile(join(matrixHome, "system/icons/custom.png"), "custom", { flag: "wx" });

      const result = await resetShippedIcons({ matrixHome, templateHome, backupStamp: "20260603T120000Z" });

      expect(result.copied).toEqual(["chess.png", "todo.svg"]);
      expect(result.backedUp).toEqual(["chess.png"]);
      expect(await readFile(join(matrixHome, "system/icons/chess.png"), "utf8")).toBe("new-chess");
      expect(await readFile(join(matrixHome, "system/icons/todo.svg"), "utf8")).toBe("new-todo");
      expect(await readFile(join(matrixHome, "system/icons/custom.png"), "utf8")).toBe("custom");
      expect(
        await readFile(join(matrixHome, "system/icon-backups/20260603T120000Z/chess.png"), "utf8"),
      ).toBe("old-chess");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports changes without writing when dry-run is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "reset-icons-dry-"));
    try {
      const templateHome = join(root, "template");
      const matrixHome = join(root, "home");
      await mkdir(join(templateHome, "system/icons"), { recursive: true });
      await mkdir(join(matrixHome, "system/icons"), { recursive: true });
      await writeFile(join(templateHome, "system/icons/chess.png"), "new-chess", { flag: "wx" });
      await writeFile(join(matrixHome, "system/icons/chess.png"), "old-chess", { flag: "wx" });

      const result = await resetShippedIcons({ matrixHome, templateHome, dryRun: true });

      expect(result.copied).toEqual(["chess.png"]);
      expect(result.backedUp).toEqual(["chess.png"]);
      expect(await readFile(join(matrixHome, "system/icons/chess.png"), "utf8")).toBe("old-chess");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips symlinked shipped sources and symlinked home targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "reset-icons-links-"));
    try {
      const templateHome = join(root, "template");
      const matrixHome = join(root, "home");
      await mkdir(join(templateHome, "system/icons"), { recursive: true });
      await mkdir(join(matrixHome, "system/icons"), { recursive: true });
      await writeFile(join(templateHome, "system/icons/real.png"), "real", { flag: "wx" });
      await symlink(join(templateHome, "system/icons/real.png"), join(templateHome, "system/icons/source-link.png"));
      await writeFile(join(matrixHome, "system/icons/target-real.png"), "target", { flag: "wx" });
      await symlink(join(matrixHome, "system/icons/target-real.png"), join(matrixHome, "system/icons/real.png"));

      const result = await resetShippedIcons({ matrixHome, templateHome });

      expect(result.copied).toEqual([]);
      expect(result.skipped).toContainEqual({ file: "source-link.png", reason: "source-symlink" });
      expect(result.skipped).toContainEqual({ file: "real.png", reason: "target-symlink" });
      expect(await readFile(join(matrixHome, "system/icons/target-real.png"), "utf8")).toBe("target");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
