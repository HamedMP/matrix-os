import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readlink, realpath, rm, statfs } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";

const run = promisify(execFile);
const LIMIT = 8 * 1024 ** 3;
const MAX_FILES = 250_000;
const Archive = z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(LIMIT), unpackedBytes: z.number().int().nonnegative().max(LIMIT),
  fileCount: z.number().int().nonnegative().max(MAX_FILES) });
const Manifest = z.strictObject({
  version: z.literal(3), baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  platform: z.literal("darwin"), arch: z.enum(["arm64", "x64"]),
  nodeVersion: z.string().regex(/^24\.\d+\.\d+$/), pnpmVersion: z.literal("10.33.4"),
  lockfileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  paths: z.strictObject({ checkout: z.literal("source.tar"), node: z.literal("toolchain/node/bin/node"),
    pnpm: z.literal("toolchain/pnpm/bin/pnpm.cjs"), electron: z.literal("runtime/Electron.app/Contents/MacOS/Electron") }),
  archives: z.strictObject({ checkout: Archive }),
});
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
async function treeStats(root: string, signal: AbortSignal, allowSymlinks = true, maxBytes = LIMIT, skipDirectory?: string, mutable = false) {
  const directories = [root]; let unpackedBytes = 0; let entries = 0; let fileCount = 0;
  while (directories.length) {
    const directory = directories.pop()!;
    signal.throwIfAborted();
    const names = await readdir(directory).catch((error: unknown) => {
      if (mutable && directory !== root && error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names) {
      signal.throwIfAborted();
      if (name.includes("\\") || /[\x00-\x1f\x7f]/.test(name)) throw supportError();
      const path = join(directory, name);
      const info = await lstat(path).catch((error: unknown) => {
        if (mutable && error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) continue;
      if (++entries > MAX_FILES || (!info.isSymbolicLink() && info.mode & 0o022)) throw supportError();
      if (info.isDirectory()) { if (path !== skipDirectory) directories.push(path); }
      else if (info.isFile() && info.nlink === 1) { unpackedBytes += info.size; fileCount++; }
      else if (allowSymlinks && info.isSymbolicLink()) {
        const target = await realpath(path); const rel = relative(root, target);
        if (isAbsolute(await readlink(path)) || rel === ".." || rel.startsWith("../")) throw supportError();
        unpackedBytes += info.size; fileCount++;
      } else throw supportError();
      if (unpackedBytes > maxBytes) throw supportError();
    }
  }
  return { unpackedBytes, fileCount };
}

export async function checkVerificationStore(store: string, signal: AbortSignal, mutable = false) {
  const info = await lstat(store);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || info.mode & 0o077 || await realpath(store) !== store) throw supportError();
  await treeStats(store, signal, false, 4 * 1024 ** 3, join(store, "v10", "projects"), mutable);
  const free = await statfs(store);
  if (Number(free.bavail) * Number(free.bsize) < 1024 ** 3) throw new MacVerificationPreparationError("insufficient-disk");
}

export async function clearVerificationStoreProjects(store: string) {
  await ownedDirectory(store);
  const version = join(store, "v10");
  const info = await lstat(version).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o022) throw supportError();
  const projects = join(version, "projects");
  const projectInfo = await lstat(projects).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!projectInfo) return;
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink() || projectInfo.uid !== process.getuid?.() || projectInfo.mode & 0o022) throw supportError();
  // Remove only pnpm's direct checkout-registration links; never walk a link
  // or recursively delete an unexpected directory in a retained cache.
  const entries = await readdir(projects, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.length > 64 || entries.some(entry => !entry.isSymbolicLink() || !/^[a-f0-9]{32}$/.test(entry.name))) throw supportError();
  await Promise.all(entries.map(entry => rm(join(projects, entry.name))));
}

// Copy into an exclusive owner-private file while hashing. Only the verified
// private copy reaches tar, so a changed app resource cannot race extraction.
async function copyVerifiedArchive(source: string, destination: string, expected: z.infer<typeof Archive>, signal: AbortSignal) {
  const input = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size !== expected.sizeBytes || before.size > LIMIT) throw supportError();
    const output = await open(destination, "wx", 0o400);
    try {
      const hash = createHash("sha256"); const chunk = Buffer.alloc(1024 * 1024); let total = 0;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
      for (;;) {
        bounded.throwIfAborted();
        const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        if ((total += bytesRead) > expected.sizeBytes) throw supportError();
        hash.update(chunk.subarray(0, bytesRead));
        let offset = 0;
        while (offset < bytesRead) {
          bounded.throwIfAborted();
          const written = await output.write(chunk, offset, bytesRead - offset, null);
          if (written.bytesWritten < 1) throw supportError();
          offset += written.bytesWritten;
        }
      }
      const after = await input.stat();
      if (total !== expected.sizeBytes || hash.digest("hex") !== expected.sha256
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw supportError();
    } finally { await output.close(); }
  } finally { await input.close(); }
}
async function extractArchive(archive: string, destination: string, expected: z.infer<typeof Archive>, signal: AbortSignal, allowSymlinks: boolean) {
  await mkdir(destination, { mode: 0o700 });
  // This tar is built from validated files by the signed Matrix build and its
  // digest was verified before this call. No URL/path from Chat reaches it.
  const extracted = await run("/usr/bin/tar", ["-xf", archive, "-C", destination,
    "--no-same-owner", "--no-same-permissions", "--no-acls", "--no-xattrs"], {
    signal, timeout: 180_000, maxBuffer: 64 * 1024, env: { ...environment(), COPYFILE_DISABLE: "1" },
  });
  if (extracted.stderr.trim()) throw supportError();
  const actual = await treeStats(destination, signal, allowSymlinks);
  if (actual.unpackedBytes !== expected.unpackedBytes || actual.fileCount !== expected.fileCount) throw supportError();
}

// Electron selects userData and acquires its single-instance lock before
// registering this provider; the preview service admits one action at a time.
// This file lock fences provider reuse and recovers crash leftovers inside that
// lifecycle. It is not a replacement for the native process singleton.
const lockAcquisitions = new Set<string>();
const busy = () => new MacVerificationPreparationError("preparation-busy");
async function profileLock(path: string) {
  if (lockAcquisitions.has(path) || lockAcquisitions.size >= 64) throw busy();
  lockAcquisitions.add(path);
  try { return await acquireProfileLock(path); }
  finally { lockAcquisitions.delete(path); }
}

async function acquireProfileLock(path: string) {
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
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.()
    || before.mode & 0o077 || before.nlink !== 1) throw busy();
  let record = "";
  let pid: number | undefined;
  try {
    if (before.size) record = (await boundedFile(path, 1024)).toString("utf8");
    pid = z.strictObject({ pid: z.number().int().positive(), token: z.uuid(), createdAt: z.number().int().nonnegative() })
      .parse(JSON.parse(record)).pid;
  } catch (error: unknown) {
    // A crash can leave a prefix of the JSON write. The native singleton and
    // serialized acquisition rule out a writer when the PID was never completed.
    const partial = /^\{"pid":([1-9]\d{0,9})(,.*)?$/.exec(record);
    if (!(error instanceof SyntaxError) || !(partial || '{"pid":'.startsWith(record))) {
      console.warn("[mac-verification] source lock unavailable", error instanceof Error ? error.name : "Error");
      throw busy();
    }
    if (partial?.[2]) pid = Number(partial[1]);
  }
  if (pid !== undefined) {
    if (pid > 2147483647) throw busy();
    try { process.kill(pid, 0); throw busy(); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  const current = await lstat(path);
  if (current.dev !== before.dev || current.ino !== before.ino || current.ctimeMs !== before.ctimeMs
    || current.size !== before.size || current.mtimeMs !== before.mtimeMs) throw busy();
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
    const [sourceArchive, node, pnpm, electron] = await Promise.all([
      member(root, manifest.paths.checkout), member(root, manifest.paths.node), member(root, manifest.paths.pnpm),
      member(root, manifest.paths.electron),
    ]);
    const [runtimeRoot, pnpmRoot] = await Promise.all([
      member(root, "runtime/Electron.app", true), member(root, "toolchain/pnpm", true),
    ]);
    await Promise.all([treeStats(runtimeRoot, signal), treeStats(pnpmRoot, signal)]);
    await Promise.all([access(node, constants.X_OK), access(electron, constants.X_OK)]);
    if (await command(node, ["--version"], root, signal) !== `v${manifest.nodeVersion}`
      || await command(node, [pnpm, "--version"], root, signal) !== manifest.pnpmVersion) throw supportError();
    const pinnedPaths = [join(root, "manifest.json"), sourceArchive, node, pnpm, electron];
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
      const free = await statfs(workspace);
      const requiredBytes = manifest.archives.checkout.sizeBytes + 2 * manifest.archives.checkout.unpackedBytes + 6 * 1024 ** 3;
      if (Number(free.bavail) * Number(free.bsize) < requiredBytes) throw new MacVerificationPreparationError("insufficient-disk");
      await mkdir(requestPath, { mode: 0o700 });
      const checkout = join(requestPath, "source");
      const sourceCopy = join(requestPath, "source.tar");
      await copyVerifiedArchive(sourceArchive, sourceCopy, manifest.archives.checkout, signal);
      await extractArchive(sourceCopy, checkout, manifest.archives.checkout, signal, true);
      const marker = await lstat(join(checkout, ".git"));
      if (!marker.isDirectory() || marker.isSymbolicLink()) throw supportError();
      const alternatives = await lstat(join(checkout, ".git", "objects", "info", "alternates")).catch(error => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (alternatives || sha256(await boundedFile(join(checkout, "pnpm-lock.yaml"), 4 * 1024 * 1024)) !== manifest.lockfileSha256
        || await command("/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD^{commit}"], checkout, signal) !== baseSha) throw supportError();
      const cachedStore = join(workspace, cacheName);
      // Dependencies are fetched only by the consented executor into this
      // owner-private mutable cache, never carried in the signed app.
      await ownedDirectory(cachedStore);
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
