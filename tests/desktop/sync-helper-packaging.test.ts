import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareSyncHelper } from "../../desktop/scripts/prepare-sync-helper.mjs";

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
});
