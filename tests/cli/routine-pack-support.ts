import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, access, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
const run = promisify(execFile);

function packedEntry(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
}
/** Offline workspace-aware packing; keep bundled dependencies and link missing ones from the existing cache.
 * This proves tarball contents + lazy command execution, NOT a clean external package-runner install. */
export async function cachedRoutinePack() {
  const root = await mkdtemp(join(tmpdir(), "routine-cli-pack-")), source = resolve("packages/sync-client");
  try {
    const options = { cwd: source, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, COREPACK_ENABLE_NETWORK: "0", MATRIX_NO_TELEMETRY: "1", PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } };
    const version = await run("pnpm", ["--version"], options);
    if (version.stdout.trim() !== "10.33.4") throw new Error("Pinned cached pnpm 10.33.4 required");
    const result = await run("pnpm", ["pack", "--config.node-linker=hoisted", "--pack-destination", root, "--json"], options);
    const metadata = JSON.parse(result.stdout), tarball = resolve(root, metadata.filename);
    await run("tar", ["-xzf", tarball, "-C", root], { timeout: 10000, maxBuffer: 1024 * 1024 });
    const pkg = join(root, "package"), manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
    for (const path of ["bin/matrix.mjs", "src/cli/commands/routines.ts", "src/cli/routine-client.ts", "src/cli/routine-input.ts", "src/cli/routine-output.ts", "src/lib/routine-ipc-relay.mjs",
      "node_modules/@matrix-os/contracts/src/routine-cli.ts", "node_modules/@matrix-os/contracts/src/bots/routine-cli.ts", "node_modules/@matrix-os/contracts/src/bots/routine-cli-ipc.ts"]) await access(join(pkg, path));
    const contracts = JSON.parse(await readFile(join(pkg, "node_modules/@matrix-os/contracts/package.json"), "utf8"));
    if (contracts.exports["./routine-cli"] !== "./src/routine-cli.ts") throw new Error("Packed routine contracts export missing");
    const links: Record<string, string> = {};
    const bundled: { name: string; target: string; dependencies: string[] }[] = [];
    const modules = join(pkg, "node_modules");
    for (const name of Object.keys(manifest.dependencies)) {
      if (name === "@matrix-os/contracts") continue;
      const target = await realpath(join(source, "node_modules", name)), destination = join(modules, name);
      const packaged = await packedEntry(destination);
      if (packaged) {
        if (!packaged.isDirectory()) throw new Error(`Unexpected packed dependency: ${name}`);
        const installed = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
        const included = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
        if (included.name !== name || typeof included.version !== "string" || included.version !== installed.version) {
          throw new Error(`Packed dependency does not match cached package: ${name}`);
        }
        bundled.push({ name, target, dependencies: Object.keys(included.dependencies ?? {}) });
        continue;
      }
      await mkdir(dirname(destination), { recursive: true });
      await symlink(target, destination, "dir");
      links[name] = target;
    }
    const transitiveLinks: Record<string, string> = {};
    // The packer can include a dependency's files without the pnpm links it uses to resolve its own dependencies.
    // A cached link retains its installed realpath, so Node resolves further dependencies from that same graph.
    for (const { name, target, dependencies } of bundled) {
      const installedModules = name.startsWith("@") ? dirname(dirname(target)) : dirname(target);
      for (const dependency of dependencies) {
        const destination = join(modules, dependency);
        const previous = transitiveLinks[dependency];
        if (await packedEntry(join(modules, name, "node_modules", dependency))) continue;
        if (!previous && await packedEntry(destination)) continue;
        const cached = await realpath(join(installedModules, dependency));
        if (previous) {
          if (previous !== cached) throw new Error(`Conflicting cached dependency: ${dependency}`);
          continue;
        }
        await mkdir(dirname(destination), { recursive: true });
        await symlink(cached, destination, "dir");
        transitiveLinks[dependency] = cached;
      }
    }
    await mkdir(join(root, "home")); await mkdir(join(root, "cwd"));
    for (const [alias, path] of Object.entries<string>(manifest.bin)) await symlink(join(pkg, path), join(root, alias));
    return { root, pkg, manifest, bundled: bundled.map(({ name }) => name), links, transitiveLinks, binPath: join(pkg, "bin/matrix.mjs"), cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
