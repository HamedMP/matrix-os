#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReleaseSnapshotEligibility } from "./release-snapshot-eligibility.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const require = createRequire(join(root, "packages/gateway/package.json"));
const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");

function usage() {
  console.error(
    "usage: publish-release-r2.mjs <version> [--channel <name>] [--severity <level>] [--changelog <text>] [--dry-run]",
  );
}

let version = "";
let channel = process.env.HOST_BUNDLE_CHANNEL || process.env.MATRIX_IMAGE_VERSION || "dev";
let severity = "normal";
let changelog = "";
let dryRun = false;

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  switch (arg) {
    case "--channel":
      channel = process.argv[++i] || channel;
      break;
    case "--severity":
      severity = process.argv[++i] || severity;
      break;
    case "--changelog":
      changelog = process.argv[++i] || changelog;
      break;
    case "--dry-run":
      dryRun = true;
      break;
    default:
      if (!version) {
        version = arg;
      }
      break;
  }
}

if (!version) {
  usage();
  process.exit(2);
}

// "none" registers the release without promoting any channel (preview/PR bundles).
if (!["dev", "canary", "beta", "stable", "none"].includes(channel)) {
  console.error(`Invalid channel: ${channel}`);
  process.exit(1);
}

const distDir = process.env.HOST_BUNDLE_DIST_DIR || join(root, "dist/host-bundle");
const bundleName = "matrix-host-bundle.tar.gz";
const bundlePath = join(distDir, bundleName);
const checksumPath = join(await mkdtemp(join(tmpdir(), "matrix-bundle-")), `${bundleName}.sha256`);
const manifestPath = join(distDir, "manifest.json");
const releasePath = join(distDir, "release.json");
const incrementalManifestPath = join(distDir, "incremental-manifest.json");
const bundleKey = `system-bundles/${version}/${bundleName}`;
const checksumKey = `${bundleKey}.sha256`;
const incrementalManifestKey = `system-bundles/${version}/incremental-manifest.json`;
const bucket = process.env.R2_BUCKET || "matrixos-sync";
const platformPublicUrl = process.env.PLATFORM_PUBLIC_URL || "https://app.matrix-os.com";
const updateType = severity === "security" ? "auto" : "manual";
const snapshotEligible = resolveReleaseSnapshotEligibility(
  channel,
  Object.hasOwn(process.env, "GOLDEN_SNAPSHOT_ELIGIBLE")
    ? process.env.GOLDEN_SNAPSHOT_ELIGIBLE
    : undefined,
);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

async function objectHead(s3, key) {
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function readObjectText(s3, key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return await response.Body.transformToString();
}

async function verifyExistingBundle(s3, key, expectedSize, expectedSha256) {
  const head = await objectHead(s3, key);
  if (!head) return false;
  if (head.ContentLength !== expectedSize) {
    throw new Error(`existing immutable bundle size mismatch for s3://${bucket}/${key}`);
  }
  if (!head.Metadata?.sha256) {
    throw new Error(`existing immutable bundle has no checksum metadata for s3://${bucket}/${key}; publish a new version or remove the unverifiable legacy object`);
  }
  if (head.Metadata.sha256 !== expectedSha256) {
    throw new Error(`existing immutable bundle checksum metadata mismatch for s3://${bucket}/${key}`);
  }
  console.log(`  Immutable object already exists: s3://${bucket}/${key}`);
  return true;
}

async function verifyExistingChecksum(s3, key, expectedSha256) {
  const head = await objectHead(s3, key);
  if (!head) return false;
  const text = await readObjectText(s3, key);
  const existingSha256 = text.trim().split(/\s+/, 1)[0] || "";
  if (existingSha256 !== expectedSha256) {
    throw new Error(`existing immutable checksum mismatch for s3://${bucket}/${key}`);
  }
  console.log(`  Immutable object already exists: s3://${bucket}/${key}`);
  return true;
}

async function uploadImmutable(s3, path, key, contentType, metadataSha256, size) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: createReadStream(path),
    ContentLength: size,
    ContentType: contentType,
    Metadata: { sha256: metadataSha256 },
    IfNoneMatch: "*",
  }));
}

function incrementalObjectEntries(incrementalManifest) {
  if (!Array.isArray(incrementalManifest.files)) return [];
  return incrementalManifest.files.map((file) => {
    if (
      !file ||
      file.type !== "file" ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.url !== "string" ||
      file.url !== `system-bundles/objects/sha256/${file.sha256}` ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error("incremental manifest contains an invalid file object entry");
    }
    return {
      key: file.url,
      path: join(distDir, "objects", "sha256", file.sha256),
      sha256: file.sha256,
      size: file.size,
    };
  });
}

function incrementalRequiresFullBundle(incrementalManifest) {
  return incrementalManifest.requiresFullBundle !== false;
}

async function validateIncrementalObjects(incrementalObjects) {
  for (const object of incrementalObjects) {
    const objectStat = await stat(object.path);
    if (objectStat.size !== object.size) {
      throw new Error(`incremental object size mismatch for ${object.path}`);
    }
    if ((await sha256(object.path)) !== object.sha256) {
      throw new Error(`incremental object checksum mismatch for ${object.path}`);
    }
  }
}

const bundleStat = await stat(bundlePath);
const checksum = await sha256(bundlePath);
const checksumText = `${checksum}  ${bundleName}\n`;
await writeFile(checksumPath, checksumText);
const checksumStat = await stat(checksumPath);
const incrementalManifestStat = await stat(incrementalManifestPath);
const incrementalManifestSha256 = await sha256(incrementalManifestPath);
const release = await readJson(releasePath);
const manifest = await readJson(manifestPath);
const incrementalManifest = await readJson(incrementalManifestPath);
const incrementalObjects = incrementalRequiresFullBundle(incrementalManifest)
  ? []
  : incrementalObjectEntries(incrementalManifest);

const registrationBody = {
  version,
  gitCommit: manifest.gitCommit || release.gitCommit || process.env.MATRIX_BUILD_SHA || "",
  gitRef: manifest.gitRef || release.gitRef || process.env.MATRIX_BUILD_REF || null,
  buildTime: manifest.buildTime || release.buildTime || new Date().toISOString(),
  bundleKey,
  checksumKey,
  incrementalManifestKey,
  incrementalManifestSha256,
  sha256: checksum,
  size: bundleStat.size,
  severity,
  updateType,
  changelog: changelog || null,
  snapshotEligible,
  ...(channel === "none" ? {} : { channel }),
};

console.log(`Publishing ${version} to channel ${channel}...`);
console.log(`  Bundle: ${bundleStat.size} bytes, sha256: ${checksum}`);

if (dryRun) {
  console.log("=== DRY RUN ===");
  console.log(`Would upload ${bundlePath} to s3://${bucket}/${bundleKey}`);
  console.log(`Would upload checksum to s3://${bucket}/${checksumKey}`);
  if (incrementalRequiresFullBundle(incrementalManifest)) {
    console.log("Incremental manifest requires full bundle; skipping incremental file object uploads.");
  } else {
    console.log(`Would upload ${incrementalObjects.length} incremental file objects`);
  }
  console.log(`Would upload incremental manifest to s3://${bucket}/${incrementalManifestKey}`);
  console.log("Would register release:");
  console.log(JSON.stringify(registrationBody, null, 2));
  process.exit(0);
}

await validateIncrementalObjects(incrementalObjects);

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID || required("R2_ACCESS_KEY_ID");
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || required("R2_SECRET_ACCESS_KEY");
const platformSecret = required("PLATFORM_SECRET");
const endpoint =
  process.env.R2_ENDPOINT ||
  (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : required("R2_ACCOUNT_ID"));
const s3 = new S3Client({
  region: "auto",
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
});

console.log("  Uploading versioned archive...");
if (!(await verifyExistingBundle(s3, bundleKey, bundleStat.size, checksum))) {
  await uploadImmutable(s3, bundlePath, bundleKey, "application/gzip", checksum, bundleStat.size);
}

console.log("  Uploading checksum...");
if (!(await verifyExistingChecksum(s3, checksumKey, checksum))) {
  await uploadImmutable(s3, checksumPath, checksumKey, "text/plain; charset=utf-8", checksum, checksumStat.size);
}

if (incrementalRequiresFullBundle(incrementalManifest)) {
  console.log("  Incremental manifest requires full bundle; skipping incremental file object uploads.");
} else {
  console.log(`  Uploading ${incrementalObjects.length} incremental file objects...`);
  for (const object of incrementalObjects) {
    if (!(await verifyExistingBundle(s3, object.key, object.size, object.sha256))) {
      await uploadImmutable(
        s3,
        object.path,
        object.key,
        "application/octet-stream",
        object.sha256,
        object.size,
      );
    }
  }
}

console.log("  Uploading incremental manifest...");
if (!(await verifyExistingBundle(s3, incrementalManifestKey, incrementalManifestStat.size, incrementalManifestSha256))) {
  await uploadImmutable(
    s3,
    incrementalManifestPath,
    incrementalManifestKey,
    "application/json; charset=utf-8",
    incrementalManifestSha256,
    incrementalManifestStat.size,
  );
}

console.log("  Registering release in platform DB...");
const res = await fetch(`${platformPublicUrl.replace(/\/$/, "")}/system-bundles/releases`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${platformSecret}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(registrationBody),
  signal: AbortSignal.timeout(30_000),
});
if (!res.ok) {
  const text = await res.text();
  throw new Error(`release registration failed: HTTP ${res.status} ${text.slice(0, 500)}`);
}
console.log(await res.text());
console.log("");
console.log(`Published ${version} to ${channel}`);
console.log(`  Release metadata: ${platformPublicUrl.replace(/\/$/, "")}/system-bundles/releases/${version}.json`);
