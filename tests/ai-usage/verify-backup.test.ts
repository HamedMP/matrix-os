import { expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealBackup } from "../../scripts/ai-usage/verify-backup";
it("refuses to re-seal a backup whose previously verified originals were altered or lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-seal-"));
  try {
    const manifest = join(root, "manifest.json"),
      mac = join(root, "mac"),
      live = join(mac, "live.jsonl"),
      index = join(mac, "index.json");
    await mkdir(mac);
    await writeFile(live, '{"n":1}\n');
    await writeFile(index, "first");
    expect((await sealBackup(manifest, [mac])).files).toBe(2);
    // Appending to a transcript is the normal case.
    await appendFile(live, '{"n":2}\n');
    expect((await sealBackup(manifest, [mac])).files).toBe(2);
    const sealed = await readFile(manifest, "utf8");
    // Silent corruption: same path, earlier bytes changed, no preserved copy.
    await writeFile(live, '{"n":9}\n{"n":2}\n');
    await expect(sealBackup(manifest, [mac])).rejects.toThrow("1 verified original");
    expect(await readFile(manifest, "utf8")).toBe(sealed);
    await writeFile(live, '{"n":1}\n{"n":2}\n');
    // A rewritten file is fine once the replaced version is preserved elsewhere in the backup.
    await writeFile(index, "second");
    await expect(sealBackup(manifest, [mac])).rejects.toThrow("1 verified original");
    await mkdir(join(root, "recovered"));
    await writeFile(join(root, "recovered", "uuid-index.json"), "first");
    expect((await sealBackup(manifest, [mac, join(root, "recovered")])).files).toBe(3);
    await rm(live);
    await expect(sealBackup(manifest, [mac, join(root, "recovered")])).rejects.toThrow("1 verified original");
  } finally {
    await rm(root, { recursive: true });
  }
});
