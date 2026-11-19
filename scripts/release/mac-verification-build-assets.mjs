// Validated build assets shared by the Mac client packaging workflow.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const gitEnvironment = { PATH: "/usr/bin:/bin", HOME: "/var/empty", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
async function regular(path) {
  if (!(await lstat(path)).isFile()) throw new Error("Mac Verification tool is not a regular file");
}

export async function validateMacVerificationElectron(app, arch) {
  const framework = join(app, "Contents/Frameworks/Electron Framework.framework");
  const aliases = { "Versions/Current": "A", "Electron Framework": "Versions/Current/Electron Framework", Resources: "Versions/Current/Resources",
    Helpers: "Versions/Current/Helpers", Libraries: "Versions/Current/Libraries" };
  for (const path of [framework, join(framework, "Versions"), join(framework, "Versions/A")]) {
    if (!(await lstat(path)).isDirectory()) throw new Error("Mac Verification Electron framework layout is invalid");
  }
  if ((await readdir(framework)).sort().join("|") !== ["Electron Framework", "Helpers", "Libraries", "Resources", "Versions"].join("|")) {
    throw new Error("Mac Verification Electron framework layout is invalid");
  }
  for (const [name, target] of Object.entries(aliases)) {
    const path = join(framework, name);
    if (!(await lstat(path)).isSymbolicLink() || await readlink(path) !== target) throw new Error("Mac Verification Electron framework alias is invalid");
    const contained = relative(await realpath(framework), await realpath(path));
    if (isAbsolute(contained) || contained === ".." || contained.startsWith("../")) throw new Error("Mac Verification Electron framework alias escapes its bundle");
  }
  for (const path of [join(app, "Contents/MacOS/Electron"), join(framework, "Versions/A/Electron Framework")]) {
    await regular(path);
    if (process.platform === "darwin") {
      const result = await exec("/usr/bin/lipo", ["-archs", path], { timeout: 30_000, maxBuffer: 8192 });
      if (result.stdout.trim() !== (arch === "x64" ? "x86_64" : arch)) throw new Error("Mac Verification Electron architecture mismatch");
    }
  }
}

/** pnpm's side-effects cache flattens framework symlinks. Re-extract with the
 * pinned package's normal checksum-verifying installer, never in shared pnpm. */
export async function installFreshMacVerificationElectron({ packageRoot, temporaryParent = tmpdir(), cacheRoot, arch = process.arch }) {
  const source = await realpath(packageRoot);
  const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (metadata.name !== "electron" || !/^\d+\.\d+\.\d+$/.test(metadata.version) || !["arm64", "x64"].includes(arch)) throw new Error("Unsupported Electron package");
  const temporary = await mkdtemp(join(temporaryParent, ".mac-verification-electron-"));
  const cleanup = () => rm(temporary, { recursive: true, force: true });
  try {
    for (const name of ["package.json", "install.js", "checksums.json"]) {
      await regular(join(source, name)); await copyFile(join(source, name), join(temporary, name));
    }
    // Only dependency resolution is shared. dist/path.txt are private writes.
    await symlink(dirname(source), join(temporary, "node_modules"));
    for (const name of ["home", "tmp", "cache"]) await mkdir(join(temporary, name));
    await exec(process.execPath, [join(temporary, "install.js")], { cwd: temporary, timeout: 600_000, maxBuffer: 256 * 1024,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(temporary, "home"), TMPDIR: join(temporary, "tmp"),
        npm_config_platform: "darwin", npm_config_arch: arch, electron_config_cache: cacheRoot ?? join(temporary, "cache") } });
    if ((await readFile(join(temporary, "dist/version"), "utf8")).replace(/^v/, "").trim() !== metadata.version
      || await readFile(join(temporary, "path.txt"), "utf8") !== "Electron.app/Contents/MacOS/Electron") throw new Error("Electron installer version mismatch");
    const app = join(temporary, "dist/Electron.app");
    await validateMacVerificationElectron(app, arch);
    return { app, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

const ARCHIVE_LIMIT = 8 * 1024 ** 3;
const ENTRY_LIMIT = 250_000;
async function archiveTreeStats(root, allowSymlinks) {
  const canonical = await realpath(root);
  const pending = [canonical]; let unpackedBytes = 0; let fileCount = 0; let entries = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const name of await readdir(directory)) {
      if (name.includes("\\") || /[\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") throw new Error("Unsafe verification archive member");
      const path = join(directory, name); const info = await lstat(path);
      if (++entries > ENTRY_LIMIT || (!info.isSymbolicLink() && info.mode & 0o022)) throw new Error("Unsafe verification archive member");
      if (info.isDirectory()) pending.push(path);
      else if (info.isFile() && info.nlink === 1) { unpackedBytes += info.size; fileCount++; }
      else if (allowSymlinks && info.isSymbolicLink()) {
        const link = await readlink(path); const target = await realpath(path); const rel = relative(canonical, target);
        if (isAbsolute(link) || rel === ".." || rel.startsWith("../")) throw new Error("Unsafe verification archive link");
        unpackedBytes += info.size; fileCount++;
      } else throw new Error("Verification archive requires regular files and directories");
      if (unpackedBytes > ARCHIVE_LIMIT) throw new Error("Verification archive is too large");
    }
  }
  return { unpackedBytes, fileCount };
}

/** The native client accepts only this signed-build-produced archive. Tar is
 * used as an OS tool, never a parser of a user-selected URL or arbitrary tar. */
export async function sealMacVerificationArchive(root, destination, { allowSymlinks = false } = {}) {
  const stats = await archiveTreeStats(root, allowSymlinks);
  // Reserve the output exclusively inside the private build staging root.
  const reserved = await open(destination, "wx", 0o600); await reserved.close();
  // Preserve the complete Git checkout as one immutable source resource.
  await exec("/usr/bin/tar", ["-cf", destination, "--format=pax", "--no-acls", "--no-xattrs", "-C", root, "."], {
    // Bound source archiving on shared Mac builders.
    // This build-only deadline does not change native extraction limits.
    env: { ...gitEnvironment, COPYFILE_DISABLE: "1" }, timeout: 600_000, maxBuffer: 64 * 1024,
  });
  await chmod(destination, 0o644);
  const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > ARCHIVE_LIMIT) throw new Error("Verification archive is too large");
    const hash = createHash("sha256"); const chunk = Buffer.alloc(1024 * 1024); let readBytes = 0;
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      readBytes += bytesRead;
      if (readBytes > info.size) throw new Error("Verification archive changed during hashing");
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (readBytes !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("Verification archive changed during hashing");
    return { sha256: hash.digest("hex"), sizeBytes: readBytes, ...stats };
  } finally { await file.close(); }
}

