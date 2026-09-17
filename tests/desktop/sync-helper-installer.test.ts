import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installPackagedSyncHelper,
  verifySyncHelper,
} from "../../desktop/src/main/sync/sync-helper-installer";

async function writeHelper(root: string, version: string, bytes: string) {
  await mkdir(root, { recursive: true });
  const executable = join(root, "matrix");
  await writeFile(executable, bytes);
  await chmod(executable, 0o755);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    available: true,
    protocolVersion: 1,
    cliVersion: version,
    platform: "darwin",
    arch: "arm64",
    executable: "matrix",
    sha256,
  }));
  return { executable, sha256 };
}

describe("packaged sync helper installer", () => {
  it("hash-verifies and copies the helper to a stable per-user immutable version path", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-sync-helper-install-"));
    const resourcesPath = join(root, "resources");
    const homeDir = join(root, "home");
    await writeHelper(join(resourcesPath, "sync-helper"), "0.3.16", "packaged helper");

    const installed = await installPackagedSyncHelper({
      resourcesPath,
      homeDir,
      platform: "darwin",
      arch: "arm64",
    });

    expect(installed.source).toBe("packaged");
    expect(installed.executable).toBe(join(homeDir, ".matrixos", "helpers", "0.3.16", "matrix"));
    await expect(readFile(installed.executable, "utf8")).resolves.toBe("packaged helper");
    expect((await stat(installed.executable)).mode & 0o777).toBe(0o700);
    await expect(verifySyncHelper(installed)).resolves.toBeUndefined();
  });

  it("keeps a verified newer compatible helper instead of silently replacing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-sync-helper-newer-"));
    const resourcesPath = join(root, "resources");
    const homeDir = join(root, "home");
    await writeHelper(join(resourcesPath, "sync-helper"), "0.3.16", "packaged helper");
    const newerDir = join(homeDir, ".matrixos", "helpers", "0.4.0");
    const newer = await writeHelper(newerDir, "0.4.0", "newer helper");
    await mkdir(join(homeDir, ".matrixos", "helpers"), { recursive: true });
    await writeFile(join(homeDir, ".matrixos", "helpers", "current.json"), JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      cliVersion: "0.4.0",
      platform: "darwin",
      arch: "arm64",
      executable: newer.executable,
      sha256: newer.sha256,
    }));

    const installed = await installPackagedSyncHelper({
      resourcesPath,
      homeDir,
      platform: "darwin",
      arch: "arm64",
    });

    expect(installed.source).toBe("current");
    expect(installed.cliVersion).toBe("0.4.0");
    await expect(readFile(installed.executable, "utf8")).resolves.toBe("newer helper");
  });

  it("rejects unsupported or tampered packaged helpers before installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-sync-helper-invalid-"));
    const resourcesPath = join(root, "resources");
    const homeDir = join(root, "home");
    const helper = await writeHelper(join(resourcesPath, "sync-helper"), "0.3.16", "packaged helper");
    await writeFile(helper.executable, "tampered helper");

    await expect(installPackagedSyncHelper({
      resourcesPath,
      homeDir,
      platform: "darwin",
      arch: "arm64",
    })).rejects.toThrow("sync_helper_digest_mismatch");
  });
});
