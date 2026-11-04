// Compile beside dist (same depth, preserving relative source-map paths).
// This directory is private to the package's existing incremental build lock.
import { copyFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export function stagedOutputDirectory(packageDirectory) {
  return join(packageDirectory, ".matrix-build-output");
}

export async function prepareBuildOutput(packageDirectory, files) {
  const output = stagedOutputDirectory(packageDirectory);
  // Also discards output left by a killed compiler after lock recovery. rm
  // unlinks a root symlink instead of following it into an unrelated directory.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { mode: 0o700 });
  // Seed intact outputs for TypeScript's incremental no-op/partial emits. The
  // caller has bounded and validated this list before any files are copied.
  for (const [file] of files) {
    const destination = join(output, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(packageDirectory, "dist", file), destination);
  }
  return output;
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
