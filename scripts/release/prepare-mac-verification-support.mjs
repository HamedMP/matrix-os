#!/usr/bin/env node
// Build the signed client's source/tool kit; frozen dependencies install in a private runtime cache.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { installFreshMacVerificationElectron, sealMacVerificationArchive, validateMacVerificationElectron } from "./mac-verification-build-assets.mjs";
export { installFreshMacVerificationElectron, sealMacVerificationArchive, validateMacVerificationElectron } from "./mac-verification-build-assets.mjs";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PNPM_VERSION = "10.33.4";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitEnvironment = { PATH: "/usr/bin:/bin", HOME: "/var/empty", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
async function git(repository, args, timeout = 60_000) {
  const result = await exec("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd: repository, env: gitEnvironment, timeout, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("Mac Verification tool is not a regular file");
}

export async function prepareMacVerificationSupport({ repository = ROOT, output = join(ROOT, "desktop/build/mac-verification-support"),
  nodePath = process.execPath, pnpmEntry, electronApp, platform = process.platform, arch = process.arch }) {
  if (platform !== "darwin" || !["arm64", "x64"].includes(arch) || !process.versions.node.startsWith("24.")) {
    throw new Error("Mac Verification support requires a native macOS Node 24 builder");
  }
  const node = await realpath(nodePath);
  const pnpm = await realpath(pnpmEntry);
  const pnpmRoot = dirname(dirname(pnpm));
  const manager = JSON.parse(await readFile(join(pnpmRoot, "package.json"), "utf8"));
  if (manager.name !== "pnpm" || manager.version !== PNPM_VERSION || !["pnpm.cjs", "pnpm.js"].includes(pnpm.split("/").at(-1))) {
    throw new Error("Mac Verification requires pnpm 10.33.4");
  }
  await regular(node); await regular(pnpm);
  const actualNode = await exec(node, ["-p", "JSON.stringify({version:process.versions.node,arch:process.arch})"], { timeout: 5_000, maxBuffer: 8192 });
  const target = JSON.parse(actualNode.stdout);
  if (target.version !== process.versions.node || target.arch !== arch) throw new Error("Mac Verification Node version/architecture mismatch");
  if (process.platform === "darwin") {
    const linkage = await exec("/usr/bin/otool", ["-L", node], { timeout: 30_000, maxBuffer: 64 * 1024 });
    const libraries = linkage.stdout.split("\n").filter(line => /^\s+/.test(line)).map(line => line.trim().split(" ")[0]);
    if (!libraries.length || libraries.some(path => !path.startsWith("/System/Library/") && !path.startsWith("/usr/lib/"))) {
      throw new Error("Mac Verification requires a standalone Node distribution");
    }
  }
  const preview = await realpath(electronApp);
  await validateMacVerificationElectron(preview, arch);
  const baseSha = await git(repository, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("Mac Verification source revision unavailable");
  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  // Never replace an arbitrary existing directory, even after a failed build.
  if (await lstat(destination).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
    throw new Error("Mac Verification support output already exists");
  }
  const temporary = await mkdtemp(join(dirname(destination), ".mac-verification-support-"));
  try {
    const paths = { checkout: "source.tar", node: "toolchain/node/bin/node", pnpm: "toolchain/pnpm/bin/pnpm.cjs",
      electron: "runtime/Electron.app/Contents/MacOS/Electron" };
    const source = join(temporary, "source");
    await mkdir(source);
    await git(source, ["init", "-q"]);
    await git(source, ["-c", "protocol.file.allow=always", "fetch", "--depth=1", "--no-tags", "--", pathToFileURL(await realpath(repository)).href, baseSha]);
    await git(source, ["checkout", "--detach", "-q", baseSha]);
    await rm(join(source, ".git/FETCH_HEAD"), { force: true });
    const project = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (project.name !== "matrix-os" || project.packageManager !== `pnpm@${PNPM_VERSION}`) throw new Error("Unsupported verification project");
    await mkdir(dirname(join(temporary, paths.node)), { recursive: true });
    await copyFile(node, join(temporary, paths.node)); await chmod(join(temporary, paths.node), 0o755);
    await cp(pnpmRoot, join(temporary, "toolchain/pnpm"), { recursive: true, dereference: false, verbatimSymlinks: true });
    // Corepack may cache the executable as dist/pnpm.cjs; retain a fixed entry.
    if (pnpm !== join(pnpmRoot, "bin/pnpm.cjs")) {
      await mkdir(join(temporary, "toolchain/pnpm/bin"), { recursive: true });
      await writeFile(join(temporary, paths.pnpm), "#!/usr/bin/env node\nrequire('../dist/pnpm.cjs');\n");
    }
    await mkdir(join(temporary, "runtime"));
    await cp(preview, join(temporary, "runtime/Electron.app"), { recursive: true, dereference: false, verbatimSymlinks: true });
    await validateMacVerificationElectron(join(temporary, "runtime/Electron.app"), arch);
    const lockfileSha256 = sha256(await readFile(join(source, "pnpm-lock.yaml")));
    const archives = {
      checkout: await sealMacVerificationArchive(source, join(temporary, paths.checkout), { allowSymlinks: true }),
    };
    await rm(source, { recursive: true });
    const manifest = { version: 3, baseSha, platform, arch, nodeVersion: process.versions.node, pnpmVersion: PNPM_VERSION,
      lockfileSha256, paths, archives };
    await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, destination);
    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function readPnpmEntry({ args = process.argv, env = process.env } = {}) {
  const index = args.indexOf("--pnpm");
  const entry = index >= 0 ? args[index + 1] : env.npm_execpath;
  if (typeof entry !== "string" || !entry) throw new Error("Run pnpm run prepare:mac-verification-support or provide --pnpm with the pinned package entry");
  return entry;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let freshElectron;
  try {
    // Use the lifecycle entry because PATH can point to pnpm's self-update wrapper.
    const pnpmEntry = await readPnpmEntry();
    const packageRoot = await realpath(join(ROOT, "desktop/node_modules/electron"));
    if (process.argv.includes("--refresh-electron")) freshElectron = await installFreshMacVerificationElectron({ packageRoot });
    const electron = freshElectron?.app ?? join(packageRoot, "dist/Electron.app");
    const result = await prepareMacVerificationSupport({ pnpmEntry, electronApp: electron });
    console.log(`Mac Verification source and tool support prepared for ${result.baseSha}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Mac Verification support build failed");
    if (error && typeof error === "object" && ("killed" in error || "signal" in error)) {
      console.error(JSON.stringify({ stage: "Mac Verification support preparation", killed: error.killed === true,
        signal: typeof error.signal === "string" ? error.signal : null,
        code: typeof error.code === "string" || typeof error.code === "number" ? error.code : null }));
    }
    process.exitCode = 1;
  } finally { await freshElectron?.cleanup(); }
}
