import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteBrowserOwnerData,
  exportBrowserDataManifest,
} from "../../packages/gateway/src/files-tree.js";

describe("Browser files-tree integration", () => {
  it("exports owner-visible Browser profile, metadata, and download paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "browser-files-tree-"));
    await mkdir(join(home, "data/browser-profiles/default"), { recursive: true });
    await mkdir(join(home, "system/browser/downloads/staging"), { recursive: true });
    await mkdir(join(home, "files/downloads"), { recursive: true });
    await writeFile(join(home, "data/browser-profiles/default/Cookies"), "cookies");
    await writeFile(join(home, "system/browser/downloads/staging/report.part"), "partial");
    await writeFile(join(home, "files/downloads/report.pdf"), "done");

    const manifest = await exportBrowserDataManifest(home, 1000);

    expect(manifest.exportedAt).toBe("1970-01-01T00:00:01.000Z");
    expect(manifest.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "data/browser-profiles", exists: true }),
      expect.objectContaining({ path: "system/browser", exists: true }),
      expect.objectContaining({ path: "files/downloads", exists: true }),
    ]));
    expect(manifest.paths.reduce((total, entry) => total + entry.entries, 0)).toBeGreaterThan(3);
  });

  it("deletes Browser owner data without following symlinks outside home", async () => {
    const home = await mkdtemp(join(tmpdir(), "browser-files-delete-"));
    const outside = await mkdtemp(join(tmpdir(), "browser-files-outside-"));
    await mkdir(join(home, "data"), { recursive: true });
    await mkdir(join(home, "system/browser"), { recursive: true });
    await mkdir(join(home, "files/downloads"), { recursive: true });
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, join(home, "data/browser-profiles"));
    await writeFile(join(home, "system/browser/session.json"), "{}");
    await writeFile(join(home, "files/downloads/report.pdf"), "done");

    await expect(deleteBrowserOwnerData(home)).resolves.toEqual({
      deleted: ["data/browser-profiles", "system/browser", "files/downloads"],
    });

    expect(existsSync(join(home, "data/browser-profiles"))).toBe(false);
    expect(existsSync(join(home, "system/browser"))).toBe(false);
    expect(existsSync(join(home, "files/downloads"))).toBe(false);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});
