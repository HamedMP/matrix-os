import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSystemInfo } from "../../packages/gateway/src/system-info.js";
import { createPreviewPairHostMetadata, createPreviewPairSystemInfoApp } from "../platform/preview-pair-host-metadata.js";

let home: string, metadata: Awaited<ReturnType<typeof createPreviewPairHostMetadata>>;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "matrix-installed-digest-"));
  metadata = await createPreviewPairHostMetadata(home);
  vi.stubEnv("MATRIX_RELEASE_FILE", metadata.releaseFile);
  vi.stubEnv("MATRIX_BOOTSTRAP_ATTESTATION_FILE", metadata.attestationFile);
});
afterEach(async () => { vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

it("exposes fresh installed digest from matching real bootstrap evidence without inventing archive metadata", () => {
  expect(getSystemInfo(home).release).toMatchObject({ sha256: metadata.sha256, bundleSha256: metadata.sha256,
    bootstrap: { targetBundleSha256: metadata.sha256 } });
});
it("the actual route captures running source without a build env and stays pinned after installed metadata changes", async () => {
  for (const key of ["MATRIX_BUILD_SHA", "MATRIX_BUILD_REF", "MATRIX_BUILD_DATE"]) vi.stubEnv(key, undefined);
  const installed = JSON.parse(await readFile(metadata.releaseFile, "utf8"));
  const app = createPreviewPairSystemInfoApp(home, installed.version);
  expect((await (await app.request("/api/system/info")).json()).build.sha).toBe(installed.gitCommit);
  const next = join(home, "next-installed-release.json");
  await writeFile(next, JSON.stringify({ ...installed, version: "v2026.10.31-next", gitCommit: "d".repeat(40) }));
  vi.stubEnv("MATRIX_RELEASE_FILE", next);
  const info = await (await app.request("/api/system/info")).json();
  expect(info.version).toBe("v2026.10.31-next");
  expect(info.runningVersion).toBe(installed.version);
  expect(info.build.sha).toBe(installed.gitCommit);
  expect(info.release.gitCommit).toBe("d".repeat(40));
});
it.each(["missing attestation", "wrong version", "sha256 contradiction", "bundle contradiction"])(
  "does not normalize unverified installed digest for %s", async fault => {
    if (fault === "missing attestation") await unlink(metadata.attestationFile);
    else if (fault === "wrong version") {
      const evidence = JSON.parse(await readFile(metadata.attestationFile, "utf8"));
      evidence.targetBundleVersion = "v2026.10.29-old";
      await writeFile(metadata.attestationFile, JSON.stringify(evidence));
    } else {
      const release = JSON.parse(await readFile(metadata.releaseFile, "utf8"));
      release[fault === "sha256 contradiction" ? "sha256" : "bundleSha256"] = "f".repeat(64);
      await writeFile(metadata.releaseFile, JSON.stringify(release));
    }
    const release = getSystemInfo(home).release;
    expect(release).not.toHaveProperty("bootstrap");
    expect(release?.sha256).not.toBe(metadata.sha256);
    expect(release?.bundleSha256).not.toBe(metadata.sha256);
  });
