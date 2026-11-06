import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "vitest";
import { previewPairBundleVersion } from "../../packages/contracts/src/preview-pair.js";
export const previewBuildRequest = { runId: 42, pairId: "11111111-1111-4111-8111-111111111111", generation: 1, pr: 3022,
  sourceSha: "a".repeat(40), requesterId: "user_maintainer" };
export async function producePreviewPairHostFixture() {
  const owned = await mkdtemp(join(tmpdir(), "eng418-host-producer-"));
  try {
  const dist = join(owned, "dist"), stage = join(owned, "stage");
  await mkdir(dist); await mkdir(join(stage, "app"), { recursive: true });
  await writeFile(join(stage, "app", "BUNDLE_VERSION"), "candidate source bytes");
  const version = previewPairBundleVersion(previewBuildRequest.pairId, 1, previewBuildRequest.sourceSha);
  const env = { ...process.env, HOST_BUNDLE_DIST_DIR: dist, HOST_BUNDLE_STAGE_DIR: stage, HOST_BUNDLE_VERSION: version,
    HOST_BUNDLE_CHANNEL: "none", MATRIX_BUILD_SHA: previewBuildRequest.sourceSha, MATRIX_BUILD_REF: `refs/pull/${previewBuildRequest.pr}/head` };
  const run = (file: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [file, ...args], { env, encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
  };
  run("scripts/host-bundle-release.mjs", "write-release");
  run("scripts/host-bundle-incremental-manifest.mjs", join(stage, "app"), join(dist, "incremental-manifest.json"), join(dist, "objects"));
  await writeFile(join(dist, "matrix-host-bundle.tar.gz"), "opaque-not-executed-bundle-bytes");
  run("scripts/host-bundle-release.mjs", "write-manifest");
  return { dist, version, directory: owned, dispose: () => rm(owned, { recursive: true, force: true }) };
  } catch (error: unknown) { await rm(owned, { recursive: true, force: true }); throw error; }
}
