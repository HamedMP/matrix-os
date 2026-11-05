// Compile beside dist (same depth, preserving relative source-map paths).
// This directory is private to the package's existing incremental build lock.
import { chmod, copyFile, lstat, mkdir, opendir, readlink, rename, rm } from "node:fs/promises";
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from "node:path";

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

// In a writable checkout dist stays a real directory. For a read-only source
// mount the provisioner may install this one exact alias to a writable peer.
// Keep the same package depth for source maps and repo-relative Kernel assets.
export async function liveOutputDirectory(pkg) {
  const dist = join(pkg, "dist");
  const info = await lstat(dist);
  if (!info.isSymbolicLink()) { await assertOutputDirectory(dist); return dist; }
  const peer = ".matrix-publish-" + basename(pkg);
  if (await readlink(dist) !== "../" + peer + "/dist") throw new Error("Unrecognized build output symlink");
  const parent = join(dirname(pkg), peer);
  await assertOutputDirectory(parent);
  const target = join(parent, "dist");
  await assertOutputDirectory(target);
  return target;
}

const exchange = `
import ctypes, os, sys
lib = ctypes.CDLL(None, use_errno=True)
a, b = map(os.fsencode, sys.argv[1:])
if sys.platform == "darwin":
    result = lib.renamex_np(a, b, 2)  # RENAME_SWAP
elif sys.platform.startswith("linux"):
    result = lib.renameat2(-100, a, -100, b, 2)  # AT_FDCWD, RENAME_EXCHANGE
else:
    raise RuntimeError("atomic directory exchange requires Linux or macOS")
if result:
    err = ctypes.get_errno()
    raise OSError(err, os.strerror(err))
`;

// No multi-rename fallback. On unsupported filesystems, permissions errors,
// process death, or helper failure the visible tree is always one whole tree.
export async function publishBuildOutput(pkg, live, previous, next) {
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  const output = stagedOutputDirectory(pkg);
  // The enclosing 0700 directory keeps these bytes private even while the final
  // code permissions are being prepared for readers without DAC override.
  const candidate = join(output, ".matrix-publication");
  await mkdir(candidate);
  const prepared = new Set();
  for (const [file] of next) {
    const top = file.split("/")[0];
    if (!prepared.has(top)) {
      await rename(join(output, top), join(candidate, top));
      prepared.add(top);
    }
    const path = join(candidate, file);
    const mode = (await lstat(path)).mode;
    await chmod(path, 0o644 | (mode & 0o111));
    let parent = dirname(path);
    while (parent !== candidate && !prepared.has(parent)) {
      await chmod(parent, 0o755);
      prepared.add(parent);
      parent = dirname(parent);
    }
  }
  await chmod(candidate, 0o755);
  const result = spawnSync("python3", ["-I", "-S", "-c", exchange, candidate, live],
    { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Atomic build publication failed: " + result.stderr.trim());
  // candidate now holds the old complete tree inside private staging. The
  // build lock owns its cleanup, including after an interrupted publication.
}
