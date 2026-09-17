import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareSyncHelper } from "../../desktop/scripts/prepare-sync-helper.mjs";

function linuxElfFixture(interpreter: string): Buffer {
  const encodedInterpreter = Buffer.from(`${interpreter}\0`, "utf8");
  const programHeaderOffset = 64;
  const programHeaderSize = 56;
  const interpreterOffset = programHeaderOffset + programHeaderSize;
  const bytes = Buffer.alloc(interpreterOffset + encodedInterpreter.byteLength);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(62, 18);
  bytes.writeBigUInt64LE(BigInt(programHeaderOffset), 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(programHeaderSize, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(3, programHeaderOffset);
  bytes.writeBigUInt64LE(BigInt(interpreterOffset), programHeaderOffset + 8);
  bytes.writeBigUInt64LE(BigInt(encodedInterpreter.byteLength), programHeaderOffset + 32);
  encodedInterpreter.copy(bytes, interpreterOffset);
  return bytes;
}

describe("Desktop sync helper packaging", () => {
  it("verifies and stages a versioned executable with its protocol manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-sync-helper-"));
    const sourceDir = join(root, "source");
    const outputDir = join(root, "output");
    await mkdir(sourceDir);
    const name = "matrix-0.3.16-darwin-arm64";
    const bytes = Buffer.from("standalone helper fixture");
    await writeFile(join(sourceDir, name), bytes);
    await chmod(join(sourceDir, name), 0o755);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(sourceDir, `${name}.sha256`), `${sha256}  ${name}\n`);

    await prepareSyncHelper({
      sourceDir,
      outputDir,
      cliVersion: "0.3.16",
      platform: "darwin",
      arch: "arm64",
    });

    await expect(readFile(join(outputDir, "matrix"), "utf8")).resolves.toBe(bytes.toString());
    expect((await stat(join(outputDir, "matrix"))).mode & 0o111).not.toBe(0);
    await expect(readFile(join(outputDir, "manifest.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      schemaVersion: 1,
      available: true,
      protocolVersion: 1,
      cliVersion: "0.3.16",
      platform: "darwin",
      arch: "arm64",
      executable: "matrix",
      sha256,
    });
  });

  it("rejects a digest mismatch without replacing a previously staged helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-sync-helper-mismatch-"));
    const sourceDir = join(root, "source");
    const outputDir = join(root, "output");
    await mkdir(sourceDir);
    await mkdir(outputDir);
    await writeFile(join(outputDir, "matrix"), "known-good");
    const name = "matrix-0.3.16-linux-x64";
    await writeFile(join(sourceDir, name), "tampered");
    await writeFile(join(sourceDir, `${name}.sha256`), `${"0".repeat(64)}  ${name}\n`);

    await expect(prepareSyncHelper({
      sourceDir,
      outputDir,
      cliVersion: "0.3.16",
      platform: "linux",
      arch: "x64",
    })).rejects.toThrow("digest mismatch");
    await expect(readFile(join(outputDir, "matrix"), "utf8")).resolves.toBe("known-good");
  });

  it("accepts a Linux helper with the target system interpreter", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-sync-helper-linux-"));
    const sourceDir = join(root, "source");
    const outputDir = join(root, "output");
    await mkdir(sourceDir);
    const name = "matrix-0.3.16-linux-x64";
    const bytes = linuxElfFixture("/lib64/ld-linux-x86-64.so.2");
    await writeFile(join(sourceDir, name), bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(sourceDir, `${name}.sha256`), `${sha256}  ${name}\n`);

    await expect(prepareSyncHelper({
      sourceDir,
      outputDir,
      cliVersion: "0.3.16",
      platform: "linux",
      arch: "x64",
    })).resolves.toBeUndefined();
  });

  it("rejects a Linux helper tied to a builder-specific ELF interpreter", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-sync-helper-nonportable-"));
    const sourceDir = join(root, "source");
    const outputDir = join(root, "output");
    await mkdir(sourceDir);
    await mkdir(outputDir);
    await writeFile(join(outputDir, "matrix"), "known-good");
    const name = "matrix-0.3.16-linux-x64";
    const bytes = linuxElfFixture("/home/builder/.local/lib/ld.so");
    await writeFile(join(sourceDir, name), bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(sourceDir, `${name}.sha256`), `${sha256}  ${name}\n`);

    await expect(prepareSyncHelper({
      sourceDir,
      outputDir,
      cliVersion: "0.3.16",
      platform: "linux",
      arch: "x64",
    })).rejects.toThrow("non-portable Linux helper interpreter");
    await expect(readFile(join(outputDir, "matrix"), "utf8")).resolves.toBe("known-good");
  });
});
