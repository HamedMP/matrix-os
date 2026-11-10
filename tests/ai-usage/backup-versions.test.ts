import { expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareBackupVersions } from "../../scripts/ai-usage/backup-versions";
it("removes redundant append snapshots only after verification, but permanently preserves replaced history", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-versions-"));
  try {
    const relative = "mac/.codex/sessions/day.jsonl",
      old = join(root, "revisions/auto-one", relative),
      current = join(root, relative);
    await mkdir(join(old, ".."), { recursive: true });
    await mkdir(join(current, ".."), { recursive: true });
    await writeFile(old, "original\n");
    await writeFile(current, "original\nnew usage\n");
    const result = await prepareBackupVersions(root);
    expect(await readFile(old, "utf8")).toBe("original\n");
    await result.finish();
    await expect(access(old)).rejects.toThrow();
    const replaced = join(root, "revisions/auto-two", relative);
    await mkdir(join(replaced, ".."), { recursive: true });
    await writeFile(replaced, "earlier complete history\n");
    await writeFile(current, "replacement\n");
    const next = await prepareBackupVersions(root);
    expect(next.archives).toHaveLength(1);
    expect(await readFile(next.archives[0], "utf8")).toBe(
      "earlier complete history\n",
    );
    await next.finish();
    expect(await readFile(next.archives[0], "utf8")).toBe(
      "earlier complete history\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
