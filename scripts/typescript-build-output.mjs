// Compile beside dist (same depth, preserving relative source-map paths).
// This directory is private to the package's existing incremental build lock.
import { copyFile, lstat, mkdir, opendir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export function stagedOutputDirectory(packageDirectory) {
  return join(packageDirectory, ".matrix-build-output");
}

export async function prepareBuildOutput(packageDirectory, files) {
  const output = stagedOutputDirectory(packageDirectory);
  // Docker development pre-provisions only generated directories as writable.
  // Retain this private root so builds need no write access to source parents.
  try { await mkdir(output, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  await clearBuildOutput(packageDirectory);
  // Seed intact outputs for TypeScript's incremental no-op/partial emits. The
  // caller has bounded and validated this list before any files are copied.
  for (const [file] of files) {
    const destination = join(output, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(packageDirectory, "dist", file), destination);
  }
  return output;
}

export async function clearBuildOutput(packageDirectory) {
  const output = stagedOutputDirectory(packageDirectory);
  let info;
  try { info = await lstat(output); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!info.isDirectory() || (info.mode & 0o077) !== 0
    || (process.getuid && info.uid !== process.getuid())) {
    throw new Error("Staged build output must be a private owned directory");
  }
  let count = 0;
  for await (const entry of await opendir(output)) {
    if (++count > 10000) throw new Error("Staged build output exceeds entry bounds");
    // rm unlinks child symlinks, never following them into source/owner data.
    await rm(join(output, entry.name), { recursive: true, force: true });
  }
}

export async function assertOutputDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error("Build output must be a regular directory");
}

export async function publishBuildOutput(packageDirectory, previous, next) {
  // Both manifests are capped at 10,000 records by the caller. Only completed,
  // validated compiler output reaches dist; failed builds never touch it.
  const hashes = new Map(previous);
  const output = stagedOutputDirectory(packageDirectory);
  for (const [file, hash] of next) {
    if (hashes.get(file) === hash) continue;
    const destination = join(packageDirectory, "dist", file);
    await mkdir(dirname(destination), { recursive: true });
    // Per-file atomic replacement prevents watchers from observing truncated
    // JavaScript. Unchanged files keep their inode/mtime and do not restart apps.
    // This is not a transactional whole-package deployment mechanism.
    await rename(join(output, file), destination);
  }
}
