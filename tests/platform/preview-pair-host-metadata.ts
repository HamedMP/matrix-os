import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createPostHogErrorTracker } from "@matrix-os/observability";
import { createInteractionLogger } from "../../packages/gateway/src/logger.js";
import { createPushAdapter } from "../../packages/gateway/src/channels/push.js";
import { registerSystemOperatorRoutes } from "../../packages/gateway/src/server/system-operator-routes.js";
import { previewPairManifestFixture } from "./preview-pair-test-support.js";

/** Real release/checksum and bootstrap-attestation producers, with a minimal tar
 * and fixture cloud-init timing logs. This is metadata qualification, not boot. */
export async function createPreviewPairHostMetadata(root: string) {
  const manifest = previewPairManifestFixture(), dist = join(root, "artifacts"), host = join(root, "host");
  const releaseScript = resolve("scripts/host-bundle-release.mjs");
  const env = { PATH: process.env.PATH, HOST_BUNDLE_DIST_DIR: dist, MATRIX_BUILD_SHA: manifest.sourceSha,
    HOST_BUNDLE_VERSION: manifest.members.owner.installedVersion, HOST_BUNDLE_CHANNEL: "none", MATRIX_BUILD_REF: "preview-test" };
  const run = (command: string, args: string[], inputEnv: NodeJS.ProcessEnv) => {
    const result = spawnSync(command, args, { env: inputEnv, encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
  };
  run(process.execPath, [releaseScript, "write-release"], env);
  await mkdir(join(host, "tmp"), { recursive: true });
  await mkdir(join(host, "opt/matrix/env"), { recursive: true });
  await mkdir(join(host, "var/lib/matrix"), { recursive: true });
  await mkdir(join(host, "var/log"), { recursive: true });
  const archive = join(dist, "matrix-host-bundle.tar.gz");
  run("tar", ["-czf", archive, "-C", join(dist, "stage"), "release.json"], env);
  await writeFile(join(dist, "incremental-manifest.json"), "{}\n");
  run(process.execPath, [releaseScript, "write-manifest"], env);
  const published = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
  const sha256 = published.bundleSha256 as string;
  expect(sha256).toMatch(/^[a-f0-9]{64}$/);
  run("tar", ["-xzf", archive, "-C", join(host, "opt/matrix")], env);
  const releaseFile = join(host, "opt/matrix/release.json");
  const installed = JSON.parse(await readFile(releaseFile, "utf8"));
  expect(installed).not.toHaveProperty("sha256"); expect(installed).not.toHaveProperty("bundleSha256");
  await writeFile(join(host, "tmp/matrix-host.tgz"), await readFile(archive));
  await writeFile(join(host, "tmp/matrix-host.tgz.sha256"), await readFile(`${archive}.sha256`));
  await writeFile(join(host, "opt/matrix/env/host.env"), `MATRIX_IMAGE_SOURCE=clean_image\nMATRIX_IMAGE_VERSION=${installed.version}\nMATRIX_TARGET_BUNDLE_SHA256=${sha256}\n`);
  await writeFile(join(host, "var/log/cloud-init-output.log"), ["matrix-host: full bootstrap required",
    ...["system_prerequisites_ready", "host_bundle_ready", "core_services_started"].map((phase, index) =>
      `matrix-host-timing phase=${phase} elapsed_seconds=${index + 1} image_source=clean_image`), ""].join("\n"));
  run("bash", [resolve("distro/customer-vps/host-bin/matrix-write-bootstrap-attestation")], {
    PATH: process.env.PATH, MATRIX_BOOTSTRAP_ATTESTATION_ROOT: host, MATRIX_BOOTSTRAP_ATTESTATION_WAIT_SECONDS: "0" });
  return { sha256, releaseFile, attestationFile: join(host, "var/lib/matrix/bootstrap-attestation.json") };
}

/** Actual system route composition. In-memory HTTP is not normal-login evidence. */
export function createPreviewPairSystemInfoApp(homePath: string, runningVersion: string) {
  const app = new Hono();
  registerSystemOperatorRoutes({ app, homePath, model: undefined, runningVersion,
    interactionLogger: createInteractionLogger(homePath), pushAdapter: createPushAdapter(),
    posthogErrorTracker: createPostHogErrorTracker({ service: "matrix-gateway", env: {} }), ownerTelemetryDistinctId: "fixture",
    upgradeBodyLimit: bodyLimit({ maxSize: 4096 }), logBestEffortFailure: (context, error) => {
      console.warn("Fixture system route failed", context, error instanceof Error ? error.name : "UnknownError");
    } });
  return app;
}
