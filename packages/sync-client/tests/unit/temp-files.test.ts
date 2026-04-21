import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStaleMatrixosTempFiles } from "../../src/lib/temp-files.js";

describe("cleanupStaleMatrixosTempFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sync-temp-cleanup-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("deletes stale Matrix temp files recursively", async () => {
    const nestedDir = join(tempDir, "nested");
    const staleTmp = join(nestedDir, "sync-state.json.matrixos-123e4567-e89b-12d3-a456-426614174000.tmp");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(staleTmp, "stale");
    const old = new Date(Date.now() - 120_000);
    await utimes(staleTmp, old, old);

    await cleanupStaleMatrixosTempFiles(tempDir, { olderThanMs: 60_000 });

    await expect(stat(staleTmp)).rejects.toThrow(/ENOENT/);
  });

  it("keeps fresh temp files and unrelated files", async () => {
    const freshTmp = join(tempDir, "config.json.matrixos-123e4567-e89b-12d3-a456-426614174000.tmp");
    const unrelated = join(tempDir, "notes.tmp");
    await writeFile(freshTmp, "fresh");
    await writeFile(unrelated, "keep");

    await cleanupStaleMatrixosTempFiles(tempDir, { olderThanMs: 60_000 });

    expect(await readdir(tempDir)).toEqual(
      expect.arrayContaining([
        "config.json.matrixos-123e4567-e89b-12d3-a456-426614174000.tmp",
        "notes.tmp",
      ]),
    );
  });

  it("does not follow symlinked directories while cleaning", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "sync-temp-outside-"));
    const outsideTmp = join(outsideDir, "outside.matrixos-123e4567-e89b-12d3-a456-426614174000.tmp");
    try {
      await writeFile(outsideTmp, "outside");
      const old = new Date(Date.now() - 120_000);
      await utimes(outsideTmp, old, old);
      await symlink(outsideDir, join(tempDir, "linked"));

      await cleanupStaleMatrixosTempFiles(tempDir, { olderThanMs: 60_000 });

      expect(await readdir(outsideDir)).toContain(
        "outside.matrixos-123e4567-e89b-12d3-a456-426614174000.tmp",
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
