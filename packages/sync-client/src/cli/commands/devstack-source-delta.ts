import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { cliError } from "../output.js";

const exec = promisify(execFile);
const utf8 = new TextDecoder("utf-8", { fatal: true });
const maxEntries = 1000;
const maxRequestBytes = 4 * 1024 * 1024;
const maxFileBytes = maxRequestBytes / 4 * 3;
const gitLimit = 4 * 1024 * 1024;
const generatedDirectories = new Set([
  "node_modules", ".pnpm-store", ".next", ".turbo", ".vite", "coverage", "dist", "playwright-report", "test-results",
]);
const privateNames = new Set([
  ".aws", ".azure", ".direnv", ".docker", ".envrc", ".git", ".gnupg", ".kube", ".matrixos", ".netrc", ".npmrc",
  ".pypirc", ".secrets", ".ssh", ".vault-token", "application_default_credentials.json", "credentials.json", "secrets.json",
]);

const protectedRoots = ["packages/platform/data", ".config/gcloud", "output", ".worktrees"];

export type DevstackSourceDeltaEntry =
  | { path: string; kind: "file"; mode: 420 | 493; content: string }
  | { path: string; kind: "delete" };
export type DevstackSourceDelta = { base: string; entries: DevstackSourceDeltaEntry[] };

const sourceError = (message: string) => cliError("devstack_source_unavailable", message);
const tooLarge = () => sourceError("DevStack source sync supports up to 1,000 changed paths and 4 MiB per request.");
const changed = () => sourceError("The Git worktree changed while collecting source. Retry synchronization.");
const symbolic = () => sourceError("Hosted DevStack source sync does not support changed symbolic links.");
const pathCollision = () => sourceError("Hosted DevStack source sync does not support overlapping file and directory changes.");

function portableName(path: string): string {
  return path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

function eligiblePath(path: string): boolean {
  // Match the hosted Platform source-delta parser before reading local bytes.
  const lower = portableName(path);
  const parts = lower.split("/");
  const name = parts.at(-1)!;
  if (protectedRoots.some(root => lower === root || lower.startsWith(root + "/")) ||
      parts.some(part => privateNames.has(part) || generatedDirectories.has(part) ||
        part === ".env" || part.startsWith(".env.")) ||
      /\.(?:env|pem|key|p12|pfx|kdbx)$/.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name) ||
      name === "next-env.d.ts" || name.endsWith(".tsbuildinfo") || name === ".build-stamp") return false;
  if (!path || path.length > 4096 || /[\\\p{Cc}\p{Cf}\p{Cs}\u2028\u2029:<>|?*"]/u.test(path) ||
      parts.length > 64 || parts.some(part => !part || /[ .]$/.test(part))) {
    throw sourceError("The Git worktree contains an unsupported path.");
  }
  return true;
}

async function git(worktree: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const { stdout } = await exec("git", [
    "-C", worktree, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.fileMode=true", ...args,
  ], { env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "buffer", maxBuffer: gitLimit, timeout: 10_000 });
  return utf8.decode(stdout);
}

function nulFields(value: string): string[] {
  if (!value) return [];
  if (!value.endsWith("\0")) throw sourceError("Git returned an invalid worktree inventory.");
  return value.slice(0, -1).split("\0");
}

async function inventory(worktree: string) {
  const base = (await git(worktree, "rev-parse", "--verify", "HEAD^{commit}")).trim();
  if (!/^[0-9a-f]{40}$/.test(base)) throw sourceError("Hosted DevStack source sync requires a SHA-1 Git baseline.");
  const [diff, untracked, index] = await Promise.all([
    git(worktree, "diff", "--raw", "--no-abbrev", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
      "--ignore-submodules=none", base, "--"),
    git(worktree, "ls-files", "--others", "--exclude-standard", "-z", "--"),
    git(worktree, "ls-files", "--stage", "-v", "-z", "--"),
  ]);
  if (nulFields(index).some(field => /^[a-zS] /.test(field))) {
    throw sourceError("Hosted DevStack source sync requires a full Git index with no hidden paths.");
  }
  if (nulFields(index).some(field => /^[A-Z] [0-7]{6} [0-9a-f]{40} [123]\t/.test(field))) {
    throw sourceError("Resolve Git conflicts before synchronizing the worktree.");
  }
  return { base, diff, untracked, index };
}

function changedPaths(diff: string, untracked: string): Map<string, boolean> {
  const paths = new Map<string, boolean>();
  const fields = nulFields(diff);
  if (fields.length % 2 !== 0) throw sourceError("Git returned an invalid worktree inventory.");
  for (let i = 0; i < fields.length; i += 2) {
    const path = fields[i + 1]!;
    if (!eligiblePath(path)) continue;
    const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} ([ADMTU])$/.exec(fields[i]!);
    if (!match || match[3] === "U") throw sourceError("Resolve Git conflicts before synchronizing the worktree.");
    const [, oldMode, newMode] = match;
    if (oldMode === "120000" || newMode === "120000") throw symbolic();
    if (oldMode === "160000" || newMode === "160000") throw sourceError("Hosted DevStack source sync does not support changed submodules.");
    paths.set(path, oldMode !== "000000");
  }
  for (const path of nulFields(untracked)) {
    if (eligiblePath(path) && !paths.has(path)) paths.set(path, false);
  }
  if (paths.size > maxEntries) throw tooLarge();
  return paths;
}

function validatePathSet(paths: Iterable<string>): void {
  const names = new Map<string, string>();
  const fileNames = new Set<string>();
  const directories = new Set<string>();
  function register(path: string) {
    const key = portableName(path);
    const registered = names.get(key);
    if (registered !== undefined && registered !== path) throw pathCollision();
    names.set(key, path);
    return key;
  }
  for (const path of paths) {
    fileNames.add(register(path));
    for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) {
      directories.add(register(parent));
    }
  }
  if ([...fileNames].some(path => directories.has(path))) throw pathCollision();
}

function stamp(stat: BigIntStats | undefined): string | undefined {
  return stat && [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.ctimeNs, stat.mtimeNs].join(":");
}

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

async function fileContents(path: string, stat: BigIntStats): Promise<string> {
  if (stat.size > maxFileBytes) throw tooLarge();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(stat)) throw changed();
    const buffer = Buffer.allocUnsafe(Number(stat.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== Number(stat.size) || stamp(await handle.stat({ bigint: true })) !== stamp(stat)) throw changed();
    return buffer.subarray(0, offset).toString("base64");
  } finally {
    await handle.close();
  }
}

export async function collectDevstackSourceDelta(worktree: string): Promise<DevstackSourceDelta> {
  try {
    const root = (await git(worktree, "rev-parse", "--show-toplevel")).replace(/\r?\n$/, "");
    if (await realpath(root) !== worktree) throw sourceError("Run source sync from the canonical Git worktree root.");
    const worktreeStat = await lstat(worktree, { bigint: true });
    if (!worktreeStat.isDirectory()) throw changed();
    const original = await inventory(worktree);
    const paths = changedPaths(original.diff, original.untracked);
    validatePathSet(paths.keys());
    const delta: DevstackSourceDelta = { base: original.base, entries: [] };
    let bytes = Buffer.byteLength(JSON.stringify(delta));

    const observed = new Map<string, BigIntStats | undefined>([[".", worktreeStat]]);
    async function observe(path: string): Promise<BigIntStats | undefined> {
      if (observed.has(path)) return observed.get(path);
      const absolute = join(worktree, path);
      const parent = await observe(posix.dirname(path));
      if (parent && !parent.isDirectory()) throw pathCollision();
      const stat = parent ? await statIfPresent(absolute) : undefined;
      if (stat?.isSymbolicLink()) throw symbolic();
      observed.set(path, stat);
      return stat;
    }

    for (const path of [...paths.keys()].sort()) {
      const absolute = join(worktree, path);
      const stat = await observe(path);
      if (!stat && !paths.get(path)) continue;
      if (stat && (!stat.isFile() || stat.nlink !== 1n)) throw sourceError("DevStack source sync requires regular files.");
      if (stat && await realpath(absolute) !== absolute) throw changed();
      if (stat && bytes + Math.ceil(Number(stat.size) / 3) * 4 > maxRequestBytes) throw tooLarge();
      const entry: DevstackSourceDeltaEntry = stat
        ? { path, kind: "file", mode: stat.mode & 0o100n ? 493 : 420, content: await fileContents(absolute, stat) }
        : { path, kind: "delete" };
      bytes += Buffer.byteLength(JSON.stringify(entry)) + (delta.entries.length ? 1 : 0);
      if (bytes > maxRequestBytes) throw tooLarge();
      delta.entries.push(entry);
    }

    const current = await inventory(worktree);
    if (current.base !== original.base || current.diff !== original.diff ||
        current.untracked !== original.untracked || current.index !== original.index) throw changed();
    for (const [path, stat] of observed) {
      // Parents are recorded first, so never follow a replaced ancestor.
      if (path !== "." && !observed.get(posix.dirname(path))) continue;
      if (stamp(await statIfPresent(join(worktree, path))) !== stamp(stat)) throw changed();
    }
    return delta;
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    if ("code" in error && error.code === "devstack_source_unavailable") throw error;
    throw sourceError("Could not read the Git worktree source. Check the checkout and retry synchronization.");
  }
}
