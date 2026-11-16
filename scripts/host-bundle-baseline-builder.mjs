// Premerge build sandbox only. Publishing stays in the separate trusted job.
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, opendir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const rootDefault = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactFiles = ["matrix-host-bundle.tar.gz", "matrix-host-bundle.tar.gz.sha256", "incremental-manifest.json", "manifest.json", "release.json"];
const publicEnv = ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_CLERK_SIGN_IN_URL", "NEXT_PUBLIC_CLERK_SIGN_UP_URL",
  "NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "NEXT_PUBLIC_POSTHOG_HOST", "NEXT_PUBLIC_POSTHOG_API_HOST",
  "HOST_BUNDLE_VERSION", "HOST_BUNDLE_CHANNEL", "HOST_BUNDLE_SEVERITY", "HOST_BUNDLE_UPDATE_TYPE", "HOST_BUNDLE_CHANGELOG",
  "MATRIX_BUILD_SHA", "MATRIX_BUILD_REF", "MATRIX_BUILD_DATE"];

export function isHostBaseline(platform, arch, header) {
  return platform === "linux" && arch === "x64" && header.glibcVersionRuntime === "2.39";
}

class CommandError extends Error {
  constructor(command, code) { super(`${command} failed (${code})`); this.code = code; }
}

async function safeDestination(root, value) {
  const destination = resolve(root, value ?? "dist/host-bundle");
  const path = relative(root, destination);
  if (isAbsolute(path) || !path.startsWith("dist/") || path.split("/").length < 2) throw new Error("Build output must be within this checkout's dist directory");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    try { if (!(await lstat(current)).isDirectory()) throw new Error("Build output path must contain only real directories"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return destination;
}

async function collectArtifacts(source, target, expected, signal) {
  for (const directory of [dirname(source), source]) {
    if (!(await lstat(directory)).isDirectory()) throw new Error("Build artifact path must contain only real directories");
  }
  async function metadata(name) {
    signal.throwIfAborted();
    const info = await lstat(join(source, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4 * 1024 ** 2) throw new Error("Build metadata must be a bounded regular file");
    try { return JSON.parse(await readFile(join(source, name), "utf8")); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new Error("Build metadata is invalid JSON"); }
  }
  const release = await metadata("release.json");
  const manifest = await metadata("manifest.json");
  for (const metadata of [release, manifest]) {
    if (!metadata || metadata.gitCommit !== expected.MATRIX_BUILD_SHA || metadata.gitRef !== expected.MATRIX_BUILD_REF || metadata.version !== expected.HOST_BUNDLE_VERSION || metadata.channel !== "none") {
      throw new Error("Built artifact provenance does not match the requested source/version/channel");
    }
  }
  let bytes = 0, count = 0;
  async function copyRegular(from, to, limit, minimum = 1) {
    signal.throwIfAborted();
    const info = await lstat(from);
    if (!info.isFile() || info.isSymbolicLink() || info.size < minimum || info.size > limit || ++count > 100_000 || (bytes += info.size) > 16 * 1024 ** 3) {
      throw new Error("Build artifact is not a bounded regular file");
    }
    await copyFile(from, to);
  }
  await mkdir(target, { recursive: true });
  for (const file of artifactFiles) await copyRegular(join(source, file), join(target, file), file.endsWith(".tar.gz") ? 8 * 1024 ** 3 : 4 * 1024 ** 2);
  const objects = join(source, "objects/sha256");
  if (!(await lstat(join(source, "objects"))).isDirectory() || !(await lstat(objects)).isDirectory()) throw new Error("Build objects must be real directories");
  await mkdir(join(target, "objects/sha256"), { recursive: true });
  for await (const entry of await opendir(objects, { bufferSize: 64 })) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) throw new Error("Invalid content-addressed build object");
    await copyRegular(join(objects, entry.name), join(target, "objects/sha256", entry.name), 1024 ** 3, 0);
  }
}

async function prepareCiPnpmStore(root, env) {
  // setup-node's trusted post action still expects its host store path to exist.
  // The build used a separate fresh store; never copy or install anything here.
  const { stdout } = await exec("pnpm", ["store", "path", "--silent"], {
    cwd: root, env, encoding: "utf8", timeout: 10_000, maxBuffer: 4096,
  });
  const store = stdout.trim();
  if (!isAbsolute(store) || resolve(store) !== store || /[\0\r\n]/.test(store)) throw new Error("Host pnpm returned an invalid cache path");
  const anchor = [env.HOME, env.RUNNER_TEMP].find(value => {
    if (!value || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value)) return false;
    const within = relative(value, store);
    return within && !isAbsolute(within) && within !== ".." && !within.startsWith("../");
  });
  if (!anchor) throw new Error("Host pnpm cache must stay within owned CI HOME or RUNNER_TEMP");
  const components = relative(anchor, store).split("/");
  if (components.length > 64 || components.some(value => value.length > 255 || !/^[A-Za-z0-9._-]+$/.test(value))) throw new Error("Host pnpm cache contains unsafe path components");
  const ownedDirectory = async path => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o002)) {
      throw new Error("Host pnpm cache path must contain only owned real directories without world write");
    }
  };
  await ownedDirectory(anchor);
  let current = await realpath(anchor);
  for (const component of components) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await ownedDirectory(current);
  }
  console.log("Host pnpm cache path is ready for the trusted post-cache action; no build data imported");
}

export async function buildInBaseline({ root = rootDefault, env = process.env, deadlineMs = 25 * 60_000 } = {}) {
  root = await realpath(root);
  const destination = await safeDestination(root, env.HOST_BUNDLE_DIST_DIR);
  if (process.getuid?.() === 0 || !process.getuid || !process.getgid) throw new Error("Baseline build requires a nonroot host user and Docker");
  if (env.HOST_BUNDLE_CHANNEL !== "none") throw new Error("Isolated premerge builds require HOST_BUNDLE_CHANNEL=none; no channel is changed automatically");
  if (!/^[a-f0-9]{40}$/.test(env.MATRIX_BUILD_SHA ?? "") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(env.HOST_BUNDLE_VERSION ?? "") || !env.MATRIX_BUILD_REF) {
    throw new Error("Set an exact MATRIX_BUILD_SHA, MATRIX_BUILD_REF and HOST_BUNDLE_VERSION for the premerge build");
  }
  if (env.HOST_BUNDLE_SKIP_SHELL_BUILD === "true") throw new Error("Isolated premerge builds require a fresh shell build");
  for (const key of ["HOST_BUNDLE_NODE_VERSION", "HOST_BUNDLE_ZELLIJ_VERSION", "HOST_BUNDLE_ZELLIJ_BINARY_SHA256", "HOST_BUNDLE_GH_VERSION", "HOST_BUNDLE_UV_INSTALLER_URL"]) {
    if (env[key] !== undefined) throw new Error("Isolated premerge builds use the source-pinned toolchain without overrides");
  }
  const forwarded = {};
  for (const key of publicEnv) if (env[key] !== undefined) {
    if (env[key].length > 4096 || /[\0\r\n]/.test(env[key])) throw new Error("Invalid public build metadata");
    forwarded[key] = env[key];
  }
  if (forwarded.HOST_BUNDLE_SEVERITY && !["normal", "security"].includes(forwarded.HOST_BUNDLE_SEVERITY)) throw new Error("Invalid build severity");
  if (forwarded.HOST_BUNDLE_UPDATE_TYPE && !["manual", "auto"].includes(forwarded.HOST_BUNDLE_UPDATE_TYPE)) throw new Error("Invalid build update type");
  const git = async (args) => (await exec("git", args, { cwd: root, env, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await git(["rev-parse", "HEAD"]) !== env.MATRIX_BUILD_SHA || await git(["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("Build requires a clean tracked checkout at exactly MATRIX_BUILD_SHA");
  }

  const temporary = await mkdtemp(join(tmpdir(), "matrix-host-builder-"));
  const name = `matrix-host-builder-${randomUUID()}`;
  const controller = new AbortController();
  let created = false, failure, output;
  const stop = () => controller.abort(new Error("Baseline build interrupted"));
  const deadline = setTimeout(() => controller.abort(new Error("Baseline build deadline exceeded")), deadlineMs);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  async function run(command, args, options = {}) {
    await new Promise((done, fail) => {
      const child = spawn(command, args, { cwd: root, env, stdio: "inherit", signal: controller.signal, ...options });
      child.once("error", fail);
      child.once("close", (code) => code === 0 ? done() : fail(new CommandError(command, code ?? 1)));
    });
  }
  try {
    const source = join(temporary, "source"), context = join(temporary, "context"), scratch = join(temporary, "scratch");
    await mkdir(source); await mkdir(context); await mkdir(scratch, { mode: 0o700 });
    await copyFile(join(root, "scripts/host-bundle-builder.Dockerfile"), join(context, "Dockerfile"));
    const archive = join(temporary, "source.tar");
    const excluded = [".env*", ".npmrc", ".netrc", "node_modules", "dist", ".next", ".matrix-build-cache", ".matrix-builder"]
      .flatMap(name => [`:(exclude,glob)${name}`, `:(exclude,glob)${name}/**`, `:(exclude,glob)**/${name}`, `:(exclude,glob)**/${name}/**`]);
    await run("git", ["archive", "--format=tar", `--output=${archive}`, env.MATRIX_BUILD_SHA, "--", ".", ...excluded,
      ":(exclude,glob)**/*.node", ":(exclude,glob)**/*.tsbuildinfo"]);
    await run("tar", ["-xf", archive, "-C", source]);
    await mkdir(join(source, ".matrix-builder/home"), { recursive: true, mode: 0o700 });
    await writeFile(join(source, ".matrix-builder/empty.npmrc"), "", { flag: "wx", mode: 0o600 });
    const iid = join(temporary, "image-id");
    await run("docker", ["build", "--platform", "linux/amd64", "--iidfile", iid, context]);
    const image = (await readFile(iid, "utf8")).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Baseline builder did not return an immutable image ID");
    // Native artifact extraction must not inherit /work/node_modules via ancestry.
    const cleanEnv = { HOME: "/work/.matrix-builder/home", TMPDIR: "/scratch", XDG_CACHE_HOME: "/work/.matrix-builder/cache", XDG_DATA_HOME: "/work/.matrix-builder/share",
      NPM_CONFIG_USERCONFIG: "/work/.matrix-builder/empty.npmrc", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      CI: "true", MATRIX_NO_TELEMETRY: "1", NEXT_TELEMETRY_DISABLED: "1", PATH: "/usr/local/bin:/usr/bin:/bin", ...forwarded };
    console.log(`Host baseline builder: ${image}; source ${env.MATRIX_BUILD_SHA}; version ${env.HOST_BUNDLE_VERSION}; channel none`);
    const memory = `${Math.max(1, Math.min(12, Math.floor(totalmem() / 1024 ** 3 * 0.75)))}g`;
    // Set before create: even a lost Docker response must clean this exact owned name.
    created = true;
    await run("docker", ["create", "--name", name, "--platform", "linux/amd64", "--init", "--user", `${process.getuid()}:${process.getgid()}`,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--pids-limit", "2048",
      "--cpus", String(Math.min(4, availableParallelism())), "--memory", memory, "--memory-swap", memory, "--shm-size", "256m",
      "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777", "--mount", `type=bind,src=${source},dst=/work`,
      "--mount", `type=bind,src=${scratch},dst=/scratch`,
      ...Object.entries(cleanEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]), image]);
    await run("docker", ["start", "--attach", name]);
    const state = (await exec("docker", ["inspect", "--format", "{{.State.ExitCode}} {{.State.Running}}", name], {
      env, timeout: 10_000, maxBuffer: 4096, signal: controller.signal,
    })).stdout.trim();
    if (state !== "0 false") throw new Error("Baseline container did not confirm a successful exit");
    // Collect on the destination filesystem; the final rename must not cross devices.
    await safeDestination(root, destination); await mkdir(dirname(destination), { recursive: true });
    output = await mkdtemp(join(dirname(destination), ".host-bundle-incoming-"));
    await collectArtifacts(join(source, "dist/host-bundle"), output, forwarded, controller.signal);
    // Validate again after the untrusted build; it never mounted the host checkout.
    await safeDestination(root, destination); await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true }); await rename(output, destination);
    console.log(join(destination, "matrix-host-bundle.tar.gz"));
  } catch (error) { failure = error; throw error;
  } finally {
    clearTimeout(deadline); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    let cleanupFailure;
    try {
      if (created) {
        // The Docker client exiting does not prove its container stopped.
        try { await exec("docker", ["rm", "--force", name], { env, timeout: 20_000, maxBuffer: 16_384 }); }
        catch (error) {
          // A failed create may have left no container. Other errors leave cleanup unconfirmed.
          if (!String(error.stderr).includes(`No such container: ${name}`)) cleanupFailure = error;
        }
      }
    } finally {
      try { await rm(temporary, { recursive: true, force: true }); }
      finally { if (output) await rm(output, { recursive: true, force: true }); }
    }
    if (cleanupFailure) throw new AggregateError([failure, cleanupFailure].filter(Boolean),
      `${failure ? failure.message + "; " : ""}container cleanup unconfirmed: ${name}`);
  }
  // Only successful artifact production AND confirmed container cleanup reach this point.
  if (env.GITHUB_ACTIONS === "true") await prepareCiPnpmStore(root, env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--check") {
    process.exitCode = isHostBaseline(process.platform, process.arch, process.report.getReport().header) ? 0 : 1;
  } else {
    try { await buildInBaseline(); }
    catch (error) { console.error(`Host baseline build failed: ${error.message}`); process.exitCode = error instanceof CommandError ? error.code : 1; }
  }
}
