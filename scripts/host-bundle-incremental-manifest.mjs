#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OBJECT_ROOT = "system-bundles/objects/sha256";
const DEFAULT_EXCLUDED_PREFIXES = ["node_modules/"];
const DEFAULT_PROTECTED_PATHS = [
  "/home/matrix/home/system/desktop.json",
  "/home/matrix/home/system/theme.json",
  "/home/matrix/home/system/wallpapers/",
  "/home/matrix/home/system/icons/",
  "/home/matrix/home/conversations/",
  "/home/matrix/home/memory/",
];

function toManifestPath(root, path) {
  const rel = relative(root, path).split(sep).join("/");
  if (!rel || rel === "." || rel.startsWith("../") || rel.includes("/../")) {
    throw new Error(`invalid app manifest path: ${rel}`);
  }
  return rel;
}

function modeString(mode) {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function compareStablePath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isExcludedPath(manifestPath, excludedPrefixes) {
  return excludedPrefixes.some((prefix) => (
    manifestPath === prefix.slice(0, -1) ||
    manifestPath.startsWith(prefix)
  ));
}

function parseExcludedPrefixes(value) {
  if (!value) return DEFAULT_EXCLUDED_PREFIXES;
  return value
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean)
    .map((prefix) => (prefix.endsWith("/") ? prefix : `${prefix}/`));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function assertRelativeSymlinkTargetInsideRoot(appRoot, linkPath, target) {
  if (target.startsWith("/")) {
    throw new Error(`symlink ${toManifestPath(appRoot, linkPath)} target is absolute`);
  }
  const resolved = resolve(dirname(linkPath), target);
  if (resolved !== appRoot && !resolved.startsWith(`${appRoot}${sep}`)) {
    throw new Error(`symlink ${toManifestPath(appRoot, linkPath)} target escapes app root`);
  }
}

async function writeObjectFile(objectDir, sha256, sourcePath) {
  if (!objectDir) return;
  const target = join(objectDir, "sha256", sha256);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(sourcePath, target);
}

async function walkAppTree(appRoot, current, entries) {
  const names = await readdir(current);
  names.sort(compareStablePath);
  for (const name of names) {
    const path = join(current, name);
    const manifestPath = toManifestPath(appRoot, path);
    if (isExcludedPath(manifestPath, entries.excludedPrefixes)) {
      continue;
    }
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      await walkAppTree(appRoot, path, entries);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      assertRelativeSymlinkTargetInsideRoot(appRoot, path, target);
      entries.symlinks.push({ path: manifestPath, target });
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`unsupported host bundle app entry: ${manifestPath}`);
    }
    const sha256 = await sha256File(path);
    await writeObjectFile(entries.objectDir, sha256, path);
    entries.files.push({
      type: "file",
      path: manifestPath,
      sha256,
      size: stat.size,
      mode: modeString(stat.mode),
      url: `${entries.objectRoot}/${sha256}`,
    });
  }
}

export async function buildIncrementalManifest(options) {
  const appRoot = resolve(options.appDir);
  const objectRoot = options.objectRoot ?? DEFAULT_OBJECT_ROOT;
  const entries = {
    files: [],
    symlinks: [],
    objectRoot,
    objectDir: options.objectDir ? resolve(options.objectDir) : null,
    excludedPrefixes: options.excludedPrefixes ?? DEFAULT_EXCLUDED_PREFIXES,
  };
  await walkAppTree(appRoot, appRoot, entries);
  entries.files.sort((a, b) => compareStablePath(a.path, b.path));
  entries.symlinks.sort((a, b) => compareStablePath(a.path, b.path));

  return {
    manifestVersion: 1,
    version: options.version,
    baseVersion: options.baseVersion ?? null,
    objectRoot,
    files: entries.files,
    symlinks: entries.symlinks,
    delete: [],
    requiresFullBundle: options.requiresFullBundle ?? true,
    excludedPrefixes: entries.excludedPrefixes,
    protected: options.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
  };
}

export function canonicalManifestJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const appDir = args[0];
  const outPath = args[1];
  const objectDir = args[2] || null;
  if (!appDir || !outPath) {
    console.error("usage: host-bundle-incremental-manifest.mjs <app-dir> <out-json> [objects-dir]");
    process.exit(2);
  }
  const manifest = await buildIncrementalManifest({
    appDir,
    objectDir,
    version: process.env.HOST_BUNDLE_VERSION || process.env.MATRIX_VERSION || "unknown",
    baseVersion: process.env.HOST_BUNDLE_BASE_VERSION || null,
    requiresFullBundle: process.env.HOST_BUNDLE_INCREMENTAL_REQUIRES_FULL_BUNDLE !== "false",
    excludedPrefixes: parseExcludedPrefixes(process.env.HOST_BUNDLE_INCREMENTAL_EXCLUDE_PREFIXES),
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, canonicalManifestJson(manifest));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
