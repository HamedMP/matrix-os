import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileCopy, fileDuplicate, fileMkdir, fileRename, fileStat, fileTouch } from "../../packages/gateway/src/file-ops";
import { fileDelete } from "../../packages/gateway/src/trash";
import { resolveExistingFileApiPath, resolveWritableFileApiPath } from "../../packages/gateway/src/path-security";
import { createPrivateStage, pinDirectory } from "../../packages/gateway/src/app-gallery/filesystem";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(await realpath(tmpdir()), "gallery-staging-ancestors-"));
  await mkdir(join(home, "data/app-gallery-staging/slot-0"), { recursive: true });
  await writeFile(join(home, "data/app-gallery-staging/slot-0/file-0"), "private template");
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("gallery staging ancestor mutations", () => {
  it.each(["data", "./data", "data/../data", "."])("rejects moving ancestor %s", async path => {
    expect(await fileRename(home, path, "relocated-data")).toMatchObject({ ok: false });
    expect(await readFile(join(home, "data/app-gallery-staging/slot-0/file-0"), "utf8")).toBe("private template");
  });
  it.each(["copy", "duplicate", "delete"])("rejects recursive %s of a staging ancestor", async operation => {
    const result = operation === "copy" ? await fileCopy(home, "data", "copied-data")
      : operation === "duplicate" ? await fileDuplicate(home, "data") : await fileDelete(home, "data");
    expect(result).toMatchObject({ ok: false });
    expect(await readdir(home)).toEqual(["data"]);
  });
  it("keeps ordinary data reads, writes and sibling mutations available", async () => {
    expect(await fileMkdir(home, "data/notes")).toMatchObject({ ok: true });
    expect(await fileTouch(home, "data/notes/one.txt", "owner data")).toMatchObject({ ok: true });
    expect(await fileStat(home, "data")).toMatchObject({ type: "directory" });
    expect(resolveExistingFileApiPath(home, "data/notes/one.txt")).toBe(join(home, "data/notes/one.txt"));
    expect(resolveWritableFileApiPath(home, "data/notes/one.txt")).toBe(join(home, "data/notes/one.txt"));
    expect(await fileCopy(home, "data/notes", "data/copied-notes")).toMatchObject({ ok: true });
    expect(await fileRename(home, "data/copied-notes", "data/moved-notes")).toMatchObject({ ok: true });
    expect(await fileDuplicate(home, "data/notes")).toMatchObject({ ok: true });
    expect(await fileDelete(home, "data/moved-notes")).toMatchObject({ ok: true });
    expect(await readFile(join(home, "data/notes/one.txt"), "utf8")).toBe("owner data");
  });
  it.skipIf(process.platform !== "linux")("cannot expose a live pinned stage by moving its ancestor", async () => {
    await rm(join(home, "data"), { recursive: true });
    const owner = await pinDirectory(home);
    const stage = await createPrivateStage(owner);
    try {
      const name = await stage.write(Buffer.from("trusted app bytes"));
      expect(await fileRename(home, "data", "relocated-data")).toMatchObject({ ok: false });
      expect(resolveWritableFileApiPath(home, `relocated-data/app-gallery-staging/slot-0/${name}`)).not.toBeNull();
      await expect(readFile(join(home, "relocated-data/app-gallery-staging/slot-0", name))).rejects.toMatchObject({ code: "ENOENT" });
      expect(resolveWritableFileApiPath(home, `data/app-gallery-staging/slot-0/${name}`)).toBeNull();
      expect(String(await stage.directory.readFile(name, 100))).toBe("trusted app bytes");
    } finally { await stage.release(); await owner.close(); }
    expect(await readdir(join(home, "data/app-gallery-staging"))).toEqual([]);
  });
});
