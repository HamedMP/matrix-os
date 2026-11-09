import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, lstat, mkdir, open, readlink, readdir, realpath, rename, rmdir, symlink, unlink, writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify, TextDecoder } from "node:util";

const exec = promisify(execFile);
const utf8 = new TextDecoder("utf-8", { fatal: true });
const maxPaths = 50_000;
const maxFileBytes = 32 * 1024 ** 2;
const maxTotalBytes = 1024 ** 3;
const maxManifestBytes = 24 * 1024 ** 2;
const generatedDirectories = new Set([
  "node_modules", ".pnpm-store", ".next", ".turbo", ".vite", "coverage", "dist", "playwright-report", "test-results",
]);
const privateNames = new Set([
  ".aws", ".azure", ".direnv", ".docker", ".envrc", ".git", ".gnupg", ".kube", ".matrixos", ".netrc", ".npmrc",
  ".pypirc", ".secrets", ".ssh", ".vault-token", "application_default_credentials.json", "credentials.json", "secrets.json",
]);
const activeDestinations = new Set();

async function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const result = await exec("git", ["-C", cwd, ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "buffer",
    maxBuffer: 16 * 1024 ** 2,
    timeout: 30_000,
  });
  return utf8.decode(result.stdout);
}

export async function canonicalWorktree(path) {
  const root = (await git(path, "rev-parse", "--show-toplevel")).replace(/\r?\n$/, "");
  if (!isAbsolute(root)) throw new Error("Git did not return an absolute worktree root.");
  return realpath(root);
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function validPath(path) {
  if (typeof path !== "string" || !path || path.length > 4096 ||
      /[\\\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(path)) return false;
  const parts = path.split("/");
  return parts.length <= 64 && parts.every(part => part && part !== "." && part !== "..");
}

function pathPolicy(path) {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  const name = parts.at(-1);
  if (parts.some(part => privateNames.has(part) || part === ".env" || part.startsWith(".env.")) ||
      /\.(?:env|pem|key|p12|pfx|kdbx)$/.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name) ||
      lower.startsWith("packages/platform/data/") || lower.startsWith(".config/gcloud/")) {
    return "sensitive";
  }
  if (parts.some(part => generatedDirectories.has(part)) ||
      name === "next-env.d.ts" || name.endsWith(".tsbuildinfo") || name === ".build-stamp" ||
      ["output", ".worktrees"].includes(parts[0])) return "generated";
}

async function statIfPresent(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
}

function ancestors(path) {
  const result = [];
  for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) result.push(parent);
  return result.reverse();
}

function directoriesFor(paths) {
  const directories = new Set();
  for (const path of paths) {
    for (const parent of ancestors(path)) directories.add(parent);
    if (directories.size > maxPaths) throw new Error("The worktree exceeds the DevStack source directory limit.");
  }
  return directories;
}

function byDepth(a, b) {
  return a.split("/").length - b.split("/").length;
}

function stamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
}

async function scanSource(path) {
  const worktree = await canonicalWorktree(path);
  const [sparse, unresolved, listing] = await Promise.all([
    git(worktree, "config", "--bool", "--get", "core.sparseCheckout").catch(error => {
      if (error.code !== 1) throw error;
      return "";
    }),
    git(worktree, "ls-files", "--unmerged", "-z"),
    git(worktree, "ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"),
  ]);
  if (sparse.trim() === "true") throw new Error("DevStack requires a complete Git worktree, not a sparse checkout.");
  if (unresolved) throw new Error("Resolve the unmerged Git index before synchronizing this worktree.");
  const paths = listing ? [...new Set(listing.slice(0, -1).split("\0"))].sort() : [];
  if (paths.length > maxPaths) throw new Error("The worktree exceeds the DevStack source path limit.");

  const dirs = new Map();
  async function sourceParent(path) {
    if (path === ".") return "directory";
    if (!dirs.has(path)) {
      if (dirs.size >= maxPaths) throw new Error("The worktree exceeds the DevStack source directory limit.");
      dirs.set(path, (async () => {
        const parent = await sourceParent(dirname(path));
        if (parent !== "directory") return parent;
        const stat = await statIfPresent(join(worktree, path));
        if (stat?.isSymbolicLink()) return "unsafeLink";
        return stat?.isDirectory() ? "directory" : "missing";
      })());
    }
    return dirs.get(path);
  }

  const excluded = { sensitive: 0, generated: 0, unsafeLink: 0, unsupported: 0 };
  const entries = new Map();
  for (let i = 0; i < paths.length; i += 64) {
    const batch = await Promise.all(paths.slice(i, i + 64).map(async path => {
      if (!validPath(path)) throw new Error("Git returned an unsupported DevStack source path.");
      const policy = pathPolicy(path);
      if (policy) {
        excluded[policy]++;
        return;
      }
      const absolute = join(worktree, path);
      const parent = await sourceParent(dirname(path));
      if (parent !== "directory") {
        if (parent === "unsafeLink") excluded.unsafeLink++;
        return;
      }
      const stat = await statIfPresent(absolute);
      if (!stat) return;
      if ((!stat.isFile() && !stat.isSymbolicLink()) || (stat.isFile() && stat.nlink !== 1n)) {
        excluded.unsupported++;
        return;
      }
      if (stat.size > maxFileBytes) throw new Error("A file exceeds the DevStack source size limit.");
      return { path, stat, stamp: stamp(stat) };
    }));
    for (const entry of batch) if (entry) entries.set(entry.path, entry);
  }

  // Validate both the literal and resolved link target. Normalizing an internal
  // ".." first could hide a symlink in the path actually followed by the kernel.
  const links = [];
  for (const entry of entries.values()) {
    if (!entry.stat.isSymbolicLink()) continue;
    const absolute = join(worktree, entry.path);
    entry.link = await readlink(absolute);
    const target = resolve(dirname(absolute), entry.link);
    const logical = relative(worktree, target);
    const tail = entry.link.replace(/^(?:\.\.?\/)+/, "");
    let actual;
    if (!isAbsolute(entry.link) && validPath(tail) && inside(worktree, target) &&
        !inside(target, absolute) && validPath(logical) && !pathPolicy(logical)) {
      actual = await realpath(absolute).catch(error => {
        if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw error;
      });
    }
    links.push({ entry, logical, actual });
  }
  let changed;
  do {
    changed = false;
    const directories = directoriesFor(entries.keys());
    for (const { entry, logical, actual } of links) {
      if (!entries.has(entry.path)) continue;
      const real = actual && relative(worktree, actual);
      if (!actual || !inside(worktree, actual) || inside(actual, join(worktree, entry.path)) ||
          (!entries.has(real) && !directories.has(real)) || (!entries.has(logical) && !directories.has(logical))) {
        entries.delete(entry.path);
        excluded.unsafeLink++;
        changed = true;
      }
    }
  } while (changed);

  let bytes = 0;
  const portableNames = new Map();
  for (const entry of entries.values()) {
    for (const name of [...ancestors(entry.path), entry.path]) {
      const key = name.normalize("NFC").toLowerCase();
      if (portableNames.has(key) && portableNames.get(key) !== name) {
        throw new Error("The worktree contains source paths that collide on case-insensitive filesystems.");
      }
      portableNames.set(key, name);
    }
    bytes += Number(entry.stat.size);
    if (bytes > maxTotalBytes) throw new Error("The worktree exceeds the DevStack source size limit.");
  }
  return { worktree, entries, files: entries.size, bytes, excluded };
}

export async function inspectSource({ worktree }) {
  const { entries, ...summary } = await scanSource(worktree);
  return { ...summary, paths: [...entries.keys()] };
}

function ownerOnly(stat) {
  return stat.uid === BigInt(process.getuid()) && (stat.mode & 0o077n) === 0n;
}

async function loadManifest(statePath, worktree, destination) {
  const stat = await statIfPresent(statePath);
  if (!stat) return;
  if (!stat.isFile() || !ownerOnly(stat) || stat.size > maxManifestBytes) {
    throw new Error("The DevStack source manifest must be a bounded owner-only file.");
  }
  const file = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = JSON.parse(await file.readFile("utf8"));
    if (state.version !== 1 || state.worktree !== worktree || state.destination !== destination ||
        !Array.isArray(state.entries) || state.entries.length > maxPaths * 2 ||
        !Array.isArray(state.directories) || state.directories.length > maxPaths * 2 ||
        !state.entries.every(entry => validPath(entry?.path) && !pathPolicy(entry.path)) ||
        !state.directories.every(path => validPath(path) && !pathPolicy(path))) {
      throw new Error("The DevStack source manifest does not belong to the selected worktree and destination.");
    }
    return state;
  } finally {
    await file.close();
  }
}

async function withStaging(path, role, action) {
  const key = createHash("sha256").update(path).digest("hex").slice(0, 24);
  const directory = join(dirname(path), `.devstack-${role}-${key}`);
  const file = join(directory, "file");
  const marker = join(directory, "owner");
  async function clear() {
    const prior = await statIfPresent(directory);
    if (!prior) return;
    if (!prior.isDirectory() || !ownerOnly(prior)) {
      throw new Error("The DevStack staging path is not an owner-only directory.");
    }
    const owned = await statIfPresent(marker);
    if (owned) {
      if (!owned.isFile() || !ownerOnly(owned) || owned.size !== BigInt(key.length)) {
        throw new Error("The DevStack staging owner marker is invalid.");
      }
      const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (await handle.readFile("utf8") !== key) throw new Error("The DevStack staging owner marker did not match.");
      } finally {
        await handle.close();
      }
      const leaf = await statIfPresent(file);
      if (leaf) await unlink(file);
      await unlink(marker);
    }
    await rmdir(directory);
  }
  await clear();
  await mkdir(directory, { mode: 0o700 });
  try {
    await writeFile(marker, key, { flag: "wx", mode: 0o600 });
    return await action(file);
  } finally {
    await clear();
  }
}

async function saveManifest(path, state) {
  const contents = JSON.stringify(state);
  if (Buffer.byteLength(contents) > maxManifestBytes) throw new Error("The DevStack source manifest is too large.");
  await withStaging(path, "manifest", async file => {
    await writeFile(file, contents, { mode: 0o600, flag: "wx" });
    await rename(file, path);
  });
}

async function boundedContents(path, entry) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || stamp(before) !== entry.stamp) {
      throw new Error("The DevStack source changed during projection. Retry synchronization.");
    }
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== Number(before.size) || stamp(await file.stat({ bigint: true })) !== entry.stamp) {
      throw new Error("The DevStack source changed during projection. Retry synchronization.");
    }
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function assertSourceParents(root, path) {
  const parent = join(root, dirname(path));
  if (await realpath(parent) !== parent) throw new Error("A DevStack source parent became a symbolic link.");
}

async function project(snapshot, destination, statePath, force) {
  const { worktree, entries, ...summary } = snapshot;
  const previous = await loadManifest(statePath, worktree, destination);
  const root = await statIfPresent(destination);
  if (root && (!root.isDirectory() || !ownerOnly(root))) {
    throw new Error("The DevStack source projection must be an owner-only directory.");
  }
  if (!root) await mkdir(destination, { mode: 0o700 });
  else if (!previous && (await readdir(destination)).length) {
    throw new Error("A new DevStack source projection must be empty.");
  }

  const oldEntries = new Map(previous?.entries.map(entry => [entry.path, entry]));
  const oldDirs = new Set(previous?.directories);
  const newDirs = directoriesFor(entries.keys());

  // Stop at non-directories so a stale symlink can never redirect any write or delete.
  const observed = new Map();
  async function observe(path) {
    if (!observed.has(path)) {
      observed.set(path, (async () => {
        const parent = dirname(path);
        if (parent !== "." && !(await observe(parent))?.isDirectory()) return;
        return statIfPresent(join(destination, path));
      })());
    }
    return observed.get(path);
  }

  const managed = new Set([...oldEntries.keys(), ...oldDirs]);
  const paths = [...new Set([...managed, ...entries.keys(), ...newDirs])];
  for (let i = 0; i < paths.length; i += 128) {
    await Promise.all(paths.slice(i, i + 128).map(async path => {
      const existing = await observe(path);
      if (existing && !managed.has(path)) throw new Error("An unmanaged path blocks the DevStack source projection.");
      if (existing && !existing.isDirectory() && !existing.isFile() && !existing.isSymbolicLink()) {
        throw new Error("An unsupported destination entry blocks the DevStack source projection.");
      }
      if (existing?.isDirectory() && !oldDirs.has(path)) {
        throw new Error("An unmanaged directory blocks the DevStack source projection.");
      }
      if (existing && !existing.isDirectory() && !oldEntries.has(path)) {
        throw new Error("An unmanaged file or symbolic link blocks the DevStack source projection.");
      }
    }));
  }

  const base = { version: 1, worktree, destination };
  const pendingEntries = new Map(oldEntries);
  for (const entry of entries.values()) {
    if (!pendingEntries.has(entry.path)) pendingEntries.set(entry.path, { path: entry.path });
  }
  const pendingDirs = new Set([...oldDirs, ...newDirs]);
  const stalePaths = [...oldEntries.keys()].filter(path => !entries.has(path));
  const staleDirs = [...oldDirs].filter(path => !newDirs.has(path)).sort((a, b) => byDepth(b, a));
  const updates = [];
  for (const entry of entries.values()) {
    const existing = await observe(entry.path);
    const before = oldEntries.get(entry.path);
    if (force || !existing || before?.stamp !== entry.stamp || before.destinationStamp !== stamp(existing)) updates.push(entry);
  }
  if (previous && !stalePaths.length && !staleDirs.length && !updates.length) {
    return { worktree, ...summary, updated: 0, removed: 0 };
  }

  // Record pending ownership before touching leaves. Retrying after a partial update
  // can reconcile these same paths without adopting a different destination.
  await saveManifest(statePath, { ...base, entries: [...pendingEntries.values()], directories: [...pendingDirs] });
  let removed = 0;
  for (const path of stalePaths.sort((a, b) => byDepth(b, a))) {
    const existing = await observe(path);
    if (!existing || existing.isDirectory()) continue;
    await assertSourceParents(destination, path);
    await unlink(join(destination, path));
    removed++;
  }
  for (const path of staleDirs) {
    if (!(await observe(path))?.isDirectory()) continue;
    await assertSourceParents(destination, path);
    try {
      await rmdir(join(destination, path));
    } catch (error) {
      if (error.code !== "ENOTEMPTY" || entries.has(path)) throw error;
    }
  }
  for (const path of [...newDirs].sort(byDepth)) {
    if ((await observe(path))?.isDirectory()) continue;
    await assertSourceParents(destination, path);
    await mkdir(join(destination, path), { mode: 0o700 });
  }

  await withStaging(destination, "project", async next => {
    const newEntries = new Map([...entries.keys()].map(path => [path, oldEntries.get(path)]));
    for (const entry of updates) {
      await assertSourceParents(worktree, entry.path);
      await assertSourceParents(destination, entry.path);
      const target = join(destination, entry.path);
      const source = join(worktree, entry.path);
      if (entry.link !== undefined) {
        if (await readlink(source) !== entry.link) throw new Error("A DevStack source link changed during projection.");
        await symlink(entry.link, next);
      } else {
        await writeFile(next, await boundedContents(source, entry), { flag: "wx", mode: 0o600 });
        await chmod(next, 0o600 | (Number(entry.stat.mode) & 0o111));
      }
      await rename(next, target);
      newEntries.set(entry.path, { path: entry.path, stamp: entry.stamp, destinationStamp: stamp(await statIfPresent(target)) });
    }
    await saveManifest(statePath, { ...base, entries: [...newEntries.values()], directories: [...newDirs] });
  });
  return { worktree, ...summary, updated: updates.length, removed };
}

export async function projectSource({ worktree, destination, statePath, force = false }) {
  if (typeof force !== "boolean") throw new Error("The DevStack projection force option must be a boolean.");
  destination = resolve(destination);
  statePath = resolve(statePath);
  destination = join(await realpath(dirname(destination)), basename(destination));
  statePath = join(await realpath(dirname(statePath)), basename(statePath));
  if (activeDestinations.has(destination) || activeDestinations.has(statePath)) {
    throw new Error("This DevStack source projection is already updating.");
  }
  activeDestinations.add(destination);
  activeDestinations.add(statePath);
  try {
    const snapshot = await scanSource(worktree);
    const root = snapshot.worktree;
    if (inside(root, destination) || inside(destination, root) || inside(root, statePath) ||
        inside(destination, statePath) || inside(statePath, destination) || inside(statePath, root)) {
      throw new Error("The Git worktree, DevStack source projection and state paths cannot overlap.");
    }
    return await project(snapshot, destination, statePath, force);
  } finally {
    activeDestinations.delete(destination);
    activeDestinations.delete(statePath);
  }
}
