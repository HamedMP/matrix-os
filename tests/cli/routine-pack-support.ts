import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
const run = promisify(execFile);
/** Offline workspace-aware packing; public runtime dependencies link only to this already cached install.
 * This proves tarball contents + lazy command execution, NOT a clean external package-runner install. */
export async function cachedRoutinePack() {
  const root = await mkdtemp(join(tmpdir(), "routine-cli-pack-")), source = resolve("packages/sync-client");
  try {
    const corepack = join(dirname(process.execPath), "corepack");
    const options = { cwd: source, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, COREPACK_ENABLE_NETWORK: "0", MATRIX_NO_TELEMETRY: "1", PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } };
    const version = await run(process.execPath, [corepack, "pnpm", "--version"], options);
    if (version.stdout.trim() !== "10.33.4") throw new Error("Pinned cached pnpm 10.33.4 required");
    const result = await run(process.execPath, [corepack, "pnpm", "pack", "--config.node-linker=hoisted", "--pack-destination", root, "--json"], options);
    const metadata = JSON.parse(result.stdout), tarball = resolve(root, metadata.filename);
    await run("tar", ["-xzf", tarball, "-C", root], { timeout: 10000, maxBuffer: 1024 * 1024 });
    const pkg = join(root, "package"), manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
    for (const path of ["bin/matrix.mjs", "src/cli/commands/routines.ts", "src/cli/routine-client.ts", "src/cli/routine-input.ts", "src/cli/routine-output.ts", "src/lib/routine-ipc-relay.mjs",
      "node_modules/@matrix-os/contracts/src/routine-cli.ts", "node_modules/@matrix-os/contracts/src/bots/routine-cli.ts", "node_modules/@matrix-os/contracts/src/bots/routine-cli-ipc.ts"]) await access(join(pkg, path));
    const contracts = JSON.parse(await readFile(join(pkg, "node_modules/@matrix-os/contracts/package.json"), "utf8"));
    if (contracts.exports["./routine-cli"] !== "./src/routine-cli.ts") throw new Error("Packed routine contracts export missing");
    const links: Record<string, string> = {};
    for (const name of Object.keys(manifest.dependencies)) {
      if (name === "@matrix-os/contracts") continue;
      const target = await realpath(join(source, "node_modules", name)), destination = join(pkg, "node_modules", name);
      await mkdir(dirname(destination), { recursive: true }); await symlink(target, destination, "dir"); links[name] = target;
    }
    await mkdir(join(root, "home")); await mkdir(join(root, "cwd"));
    for (const [alias, path] of Object.entries<string>(manifest.bin)) await symlink(join(pkg, path), join(root, alias));
    return { root, pkg, manifest, links, binPath: join(pkg, "bin/matrix.mjs"), cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
