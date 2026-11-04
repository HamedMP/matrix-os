import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareBaseImage, cleanupLocalParityResources, down } from "../../scripts/dev-production-parity.mjs";

it.each(["interruption", "bad checksum", "legacy partial"])("recovers an image cache after %s", async (failure) => {
  const directory = mkdtempSync(join(tmpdir(), "parity-image-"));
  const imagePath = join(directory, "ubuntu.img");
  const checksumPath = join(directory, "ubuntu.sha256");
  const body = Buffer.from("verified Ubuntu fixture");
  const checksum = createHash("sha256").update(body).digest("hex");
  let broken = failure !== "legacy partial";
  if (!broken) writeFileSync(imagePath, "old partial");
  const execute = async (_command: string, args: string[]) => {
    const target = args.at(-1)!;
    if (args.includes("https://fixture.invalid/ubuntu.img")) {
      writeFileSync(target, broken && failure === "interruption" ? "partial" : body);
      if (broken && failure === "interruption") throw new Error("interrupted");
    } else writeFileSync(target, `${broken ? "0".repeat(64) : checksum} *ubuntu.img\n`);
  };
  const options = { imagePath, checksumPath, imageUrl: "https://fixture.invalid/ubuntu.img", execute };
  try {
    if (broken) {
      await expect(prepareBaseImage(undefined, options)).rejects.toThrow();
      expect(existsSync(imagePath)).toBe(false);
      expect(existsSync(checksumPath)).toBe(false);
    }
    broken = false;
    await prepareBaseImage(undefined, options);
    expect(readFileSync(imagePath)).toEqual(body);
    expect(readFileSync(checksumPath, "utf8")).toContain(checksum);
    await prepareBaseImage(undefined, { ...options, execute: async () => { throw new Error("valid cache redownloaded"); } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("preserves stopped guest files on failure but removes them on explicit teardown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "parity-guest-"));
  const disk = join(directory, "disk.qcow2");
  const key = join(directory, "operator-key");
  writeFileSync(disk, "retained guest bytes");
  writeFileSync(key, "retained key");
  const options = { stopRuntime: async () => {}, stopContainers: [], removeRuntime: () => rmSync(directory, { recursive: true, force: true }) };
  try {
    await cleanupLocalParityResources(options);
    expect(existsSync(disk)).toBe(true);
    expect(readFileSync(disk, "utf8")).toBe("retained guest bytes");
    expect(readFileSync(key, "utf8")).toBe("retained key");
    await down({ cleanupBuilder: () => {}, cleanupResources: (choice: { preserveRuntime: boolean }) => cleanupLocalParityResources({ ...options, ...choice }) });
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
