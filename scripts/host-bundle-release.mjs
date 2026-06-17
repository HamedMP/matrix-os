#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const distDir = process.env.HOST_BUNDLE_DIST_DIR || join(root, "dist/host-bundle");
const stageDir = join(distDir, "stage");
const bundleName = "matrix-host-bundle.tar.gz";

function git(args, fallback) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return fallback;
  }
}

function releaseMetadata() {
  const gitCommit = process.env.MATRIX_BUILD_SHA || git(["rev-parse", "HEAD"], "unknown");
  const gitRef = process.env.MATRIX_BUILD_REF || process.env.GITHUB_REF_NAME || git(["rev-parse", "--abbrev-ref", "HEAD"], "unknown");
  const version = process.env.HOST_BUNDLE_VERSION || process.env.MATRIX_VERSION || git(["describe", "--tags", "--always", "--dirty"], gitCommit.slice(0, 12));
  const channel = process.env.HOST_BUNDLE_CHANNEL || "dev";
  const buildTime = process.env.MATRIX_BUILD_DATE || new Date().toISOString();
  return {
    schemaVersion: 1,
    kind: "matrix-os-host-bundle",
    version,
    channel,
    gitCommit,
    gitRef,
    buildTime,
  };
}

function releasePolicy() {
  const severity = process.env.HOST_BUNDLE_SEVERITY || "normal";
  const updateType = process.env.HOST_BUNDLE_UPDATE_TYPE || (severity === "security" ? "auto" : "manual");
  const changelog = process.env.HOST_BUNDLE_CHANGELOG || "";
  return { severity, updateType, changelog };
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });
  return hash.digest("hex");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeRelease() {
  const release = releaseMetadata();
  await writeJson(join(stageDir, "release.json"), release);
  await writeJson(join(distDir, "release.json"), release);
}

async function writeManifest() {
  const release = JSON.parse(await readFile(join(distDir, "release.json"), "utf8"));
  const policy = releasePolicy();
  const bundlePath = join(distDir, bundleName);
  const incrementalManifestPath = join(distDir, "incremental-manifest.json");
  const checksum = await sha256(bundlePath);
  const bundleStat = await stat(bundlePath);
  const incrementalManifestChecksum = await sha256(incrementalManifestPath);
  const incrementalManifestStat = await stat(incrementalManifestPath);
  const checksumText = `${checksum}  ${bundleName}\n`;
  await writeFile(join(distDir, `${bundleName}.sha256`), checksumText);
  const manifest = {
    ...release,
    ...policy,
    published: release.buildTime,
    sha256: checksum,
    size: bundleStat.size,
    bundleSha256: checksum,
    files: {
      bundle: {
        path: `system-bundles/${release.version}/${bundleName}`,
        sha256: checksum,
        size: bundleStat.size,
      },
      checksum: {
        path: `system-bundles/${release.version}/${bundleName}.sha256`,
        sha256: await sha256(join(distDir, `${bundleName}.sha256`)),
        size: Buffer.byteLength(checksumText),
      },
      incrementalManifest: {
        path: `system-bundles/${release.version}/incremental-manifest.json`,
        sha256: incrementalManifestChecksum,
        size: incrementalManifestStat.size,
      },
    },
  };
  await writeJson(join(distDir, "manifest.json"), manifest);
}

const command = process.argv[2];
if (command === "write-release") {
  await writeRelease();
} else if (command === "write-manifest") {
  await writeManifest();
} else {
  console.error("usage: host-bundle-release.mjs <write-release|write-manifest>");
  process.exit(2);
}
