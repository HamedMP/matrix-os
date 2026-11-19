import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, statfs } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";

const run = promisify(execFile);
const Manifest = z.strictObject({
  version: z.literal(1), baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  platform: z.literal("darwin"), arch: z.enum(["arm64", "x64"]),
  nodeVersion: z.string().regex(/^24\.\d+\.\d+$/), pnpmVersion: z.literal("10.33.4"),
  lockfileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  paths: z.strictObject({ checkout: z.literal("source"), node: z.literal("toolchain/node/bin/node"),
    pnpm: z.literal("toolchain/pnpm/bin/pnpm.cjs"), electron: z.literal("runtime/Electron.app/Contents/MacOS/Electron"),
    store: z.literal("pnpm-store") }),
});
const LIMIT = 8 * 1024 ** 3;
const MAX_FILES = 250_000;
export interface VerificationToolchain { node: string; pnpm: string; store: string }
export interface PreparedVerificationSource {
  checkout: string; electronPath: string; identity: string; toolchain: VerificationToolchain;
  check(signal: AbortSignal): Promise<boolean>;
  release(): Promise<void>;
}
declare const __MAC_VERIFICATION_SUPPORT_SHA256__: string | null;
interface Options { resourcesPath: string; userData: string; platform?: string; arch?: string; expectedManifestSha256?: string | null }
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export const MAC_VERIFICATION_PREPARATION_ERRORS = ["support-unavailable", "unsupported-version", "insufficient-disk", "preparation-busy"] as const;
export class MacVerificationPreparationError extends Error {
  constructor(readonly code: typeof MAC_VERIFICATION_PREPARATION_ERRORS[number]) { super(code); }
}
function supportError() { return new MacVerificationPreparationError("support-unavailable"); }
const environment = () => ({ PATH: "/usr/bin:/bin", HOME: "/var/empty", LANG: "en_US.UTF-8",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
async function command(program: string, args: string[], cwd: string, signal: AbortSignal) {
  const result = await run(program, args, { cwd, signal, timeout: 15_000, maxBuffer: 64 * 1024, env: environment() });
  if (result.stderr.trim()) throw supportError();
  return result.stdout.trim();
}
async function boundedFile(path: string, maximum: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw supportError();
    const content = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(content, 0, content.length, 0);
    if (bytesRead !== stat.size) throw supportError();
    return content.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
async function ownedDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077
    || await realpath(path) !== path) throw supportError();
}
async function identity(paths: string[]) {
  return JSON.stringify(await Promise.all(paths.map(async path => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw supportError();
    return [path, info.dev, info.ino, info.size, info.mtimeMs];
  })));
}
async function member(root: string, path: string, directory = false) {
  const full = join(root, path);
  const resolved = await realpath(full);
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("../") || rel === "..") throw supportError();
  const info = await lstat(resolved);
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.mode & 0o022) throw supportError();
  return resolved;
}
async function treeBytes(root: string, signal: AbortSignal) {
  const directories = [root]; let bytes = 0; let files = 0;
  while (directories.length) {
    const directory = directories.pop()!;
    signal.throwIfAborted();
    for (const name of await readdir(directory)) {
      signal.throwIfAborted();
      const path = join(directory, name); const info = await lstat(path);
      if (++files > MAX_FILES || (bytes += info.size) > LIMIT) throw supportError();
      if (!info.isSymbolicLink() && info.mode & 0o022) throw supportError();
      if (info.isDirectory()) directories.push(path);
      else if (info.isSymbolicLink()) {
        const rel = relative(root, await realpath(path));
        if (rel === ".." || rel.startsWith("../")) throw supportError();
      } else if (!info.isFile()) throw supportError();
    }
  }
  return bytes;
}
async function copyBounded(source: string, destination: string, signal: AbortSignal) {
  let bytes = 0; let files = 0;
  await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false,
    filter: async path => {
      signal.throwIfAborted();
      const info = await lstat(path);
      if (++files > MAX_FILES || (bytes += info.size) > LIMIT) throw supportError();
      if (!info.isSymbolicLink() && info.mode & 0o022) throw supportError();
      if (info.isSymbolicLink()) {
        const target = await realpath(path);
        const rel = relative(source, target);
        if (rel.startsWith("../") || rel === "..") throw supportError();
      } else if (!info.isFile() && !info.isDirectory()) throw supportError();
      return true;
    },
  });
}

// Electron selects userData and acquires its single-instance lock before
// registering this provider; the preview service admits one action at a time.
// This file lock fences provider reuse and recovers crash leftovers inside that
// lifecycle. It is not a replacement for the native process singleton.
async function profileLock(path: string) {
  async function create() {
    const lock = await open(path, "wx", 0o600);
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: Date.now() })); }
    catch (error: unknown) { await lock.close(); await rm(path); throw error; }
    const identity = await lock.stat();
    return { async release() {
      await lock.close();
      const current = await lstat(path);
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw supportError();
      await rm(path);
    } };
  }
  try { return await create(); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const busy = () => new MacVerificationPreparationError("preparation-busy");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() || before.mode & 0o077) throw busy();
  let previous: { pid: number; token: string; createdAt: number };
  try {
    previous = z.strictObject({ pid: z.number().int().positive(), token: z.uuid(), createdAt: z.number().int().nonnegative() })
      .parse(JSON.parse((await boundedFile(path, 1024)).toString("utf8")));
  } catch (error: unknown) {
    console.warn("[mac-verification] source lock unavailable", error instanceof Error ? error.name : "Error");
    throw busy();
  }
  try { process.kill(previous.pid, 0); throw busy(); }
  catch (error: unknown) {
    // A live/reused PID, unknown process state or malformed record is never
    // reclaimed by a timer. Only a dead writer permits crash recovery.
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  const current = await lstat(path);
  if (current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) throw busy();
  await rm(path);
  try { return await create(); }
  catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw busy();
    throw error;
  }
}

/** A signed desktop supplies all executable inputs. Chat supplies only the
 * admitted Git base; it cannot select a local path, tool, clone URL or script. */
export function createMacVerificationSourceProvider(options: Options) {
  const kit = join(options.resourcesPath, "mac-verification-support");
  const expectedManifestSha256 = options.expectedManifestSha256 ?? (typeof __MAC_VERIFICATION_SUPPORT_SHA256__ === "undefined"
    ? null : __MAC_VERIFICATION_SUPPORT_SHA256__);
  async function prepareChecked(baseSha: string, signal: AbortSignal): Promise<PreparedVerificationSource> {
    signal.throwIfAborted();
    let bytes: Buffer;
    let decoded: unknown;
    try {
      bytes = await boundedFile(join(kit, "manifest.json"), 16 * 1024);
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch (error: unknown) {
      console.warn("[mac-verification] support manifest unavailable", error instanceof Error ? error.name : "Error");
      throw supportError();
    }
    if (!expectedManifestSha256 || !/^[a-f0-9]{64}$/.test(expectedManifestSha256) || sha256(bytes) !== expectedManifestSha256) throw supportError();
    const parsed = Manifest.safeParse(decoded);
    if (!parsed.success || parsed.data.platform !== (options.platform ?? process.platform)
      || parsed.data.arch !== (options.arch ?? process.arch)) throw supportError();
    const manifest = parsed.data;
    if (manifest.baseSha !== baseSha) throw new MacVerificationPreparationError("unsupported-version");
    const root = await realpath(kit);
    const profile = await lstat(options.userData);
    if (!profile.isDirectory() || profile.isSymbolicLink() || profile.uid !== process.getuid?.()) throw supportError();
    const workspace = join(await realpath(options.userData), "mac-verification-support");
    const [source, node, pnpm, electron, store] = await Promise.all([
      member(root, manifest.paths.checkout, true), member(root, manifest.paths.node), member(root, manifest.paths.pnpm),
      member(root, manifest.paths.electron), member(root, manifest.paths.store, true),
    ]);
    // Framework aliases and pnpm's bundled support modules are executable
    // inputs too. A copied absolute donor link must not escape the signed kit
    // (or appear healthy until Chromium later fails to locate ICU resources).
    const [runtimeRoot, pnpmRoot] = await Promise.all([
      member(root, "runtime/Electron.app", true), member(root, "toolchain/pnpm", true),
    ]);
    await Promise.all([treeBytes(runtimeRoot, signal), treeBytes(pnpmRoot, signal)]);
    const marker = await lstat(join(source, ".git"));
    if (!marker.isDirectory() || marker.isSymbolicLink()) throw supportError();
    const alternatives = await lstat(join(source, ".git", "objects", "info", "alternates")).catch(error => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (alternatives) throw supportError();
    await Promise.all([access(node, constants.X_OK), access(electron, constants.X_OK)]);
    const lockfile = join(source, "pnpm-lock.yaml");
    if (await realpath(lockfile) !== lockfile || sha256(await boundedFile(lockfile, 4 * 1024 * 1024)) !== manifest.lockfileSha256
      || await command("/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD^{commit}"], source, signal) !== baseSha
      || await command(node, ["--version"], root, signal) !== `v${manifest.nodeVersion}`
      || await command(node, [pnpm, "--version"], root, signal) !== manifest.pnpmVersion) throw supportError();
    const pinnedPaths = [join(root, "manifest.json"), source, join(source, ".git"), lockfile, node, pnpm, electron];
    const sourceIdentity = await identity(pinnedPaths);
    await ownedDirectory(workspace);
    const lockPath = join(workspace, "preparation.lock");
    const lock = await profileLock(lockPath);
    const requestPath = join(workspace, `request-${randomUUID()}`);
    let released = false;
    const release = async () => {
      if (released) return; released = true;
      try { await rm(requestPath, { recursive: true, force: true }); }
      finally { await lock.release(); }
    };
    try {
      signal.throwIfAborted();
      const free = await statfs(workspace);
      const [sourceBytes, storeBytes] = await Promise.all([treeBytes(source, signal), treeBytes(store, signal)]);
      // Account for the private source projection, disposable Git worktree,
      // store/install materialization and build output. Do not demand the
      // maximum accepted kit size when the actual support is much smaller.
      const requiredBytes = Math.max(2 * 1024 ** 3, 2 * (sourceBytes + storeBytes) + 1024 ** 3);
      if (Number(free.bavail) * Number(free.bsize) < requiredBytes) throw new MacVerificationPreparationError("insufficient-disk");
      const cacheName = `store-${sha256(bytes)}`;
      const entries = await readdir(workspace);
      if (entries.length > 64) throw supportError();
      // The exclusive profile lock proves these are not live in this profile.
      // Never follow links or clean unknown/user-named directories.
      for (const name of entries) {
        if (!(/^(?:request-|\.store-)[a-f0-9-]{36}$/.test(name) || (/^store-[a-f0-9]{64}$/.test(name) && name !== cacheName))) continue;
        const path = join(workspace, name); const info = await lstat(path);
        if (info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.()) await rm(path, { recursive: true });
      }
      const cachedStore = join(workspace, cacheName);
      const existing = await lstat(cachedStore).catch(error => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (!existing) {
        const staging = join(workspace, `.store-${randomUUID()}`);
        try { await copyBounded(store, staging, signal); await rename(staging, cachedStore); }
        finally { await rm(staging, { recursive: true, force: true }); }
      } else if (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== process.getuid?.()) throw supportError();
      await mkdir(requestPath, { mode: 0o700 });
      const checkout = join(requestPath, "source");
      await copyBounded(source, checkout, signal);
      signal.throwIfAborted();
      if (await identity(pinnedPaths) !== sourceIdentity) throw supportError();
      return { checkout, electronPath: electron, identity: sourceIdentity,
        toolchain: { node, pnpm, store: cachedStore }, release,
        async check(boundarySignal) { return !released && !boundarySignal.aborted && await identity(pinnedPaths) === sourceIdentity; },
      };
    } catch (error: unknown) { await release(); throw error; }
  }
  return {
    async prepare(baseSha: string, signal: AbortSignal) {
      try { return await prepareChecked(baseSha, signal); }
      catch (error: unknown) {
        if (signal.aborted || error instanceof MacVerificationPreparationError) throw error;
        console.warn("[mac-verification] source preparation unavailable", error instanceof Error ? error.name : "Error");
        throw supportError();
      }
    },
  };
}
