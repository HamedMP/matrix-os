import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDriveUploadFile, saveDriveDownloadFile } from "../../desktop/src/main/files/organization-drive-file-io";

describe("native organization drive local files", () => {
  it("reads a selected regular file and saves a verified download atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-drive-io-"));
    try {
      const source = join(root, "source.txt");
      const destination = join(root, "download.txt");
      await writeFile(source, "source bytes");
      const selected = await readDriveUploadFile(source);
      expect(selected.name).toBe("source.txt");
      expect(new TextDecoder().decode(selected.bytes)).toBe("source bytes");
      await saveDriveDownloadFile(destination, selected.bytes);
      expect(await readFile(destination, "utf8")).toBe("source bytes");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a symlink selected for upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-drive-io-"));
    try {
      const source = join(root, "source.txt");
      const linked = join(root, "linked.txt");
      await writeFile(source, "secret");
      await symlink(source, linked);
      await expect(readDriveUploadFile(linked)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not publish a download after its session is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-drive-io-"));
    try {
      const destination = join(root, "download.txt");
      await expect(saveDriveDownloadFile(destination, new TextEncoder().encode("private"), () => false))
        .rejects.toThrow();
      await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
