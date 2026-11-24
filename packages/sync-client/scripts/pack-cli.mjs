#!/usr/bin/env node
// Packs the publishable CLI tarball. Every release and validation path must
// use this instead of a bare `pnpm pack`.
//
// The CLI bundles the private `@matrix-os/contracts` workspace package. npm
// treats each dependency of a bundled package as part of the bundle whenever
// it sits beside that package, which is the layout of `npm install -g` (and of
// Homebrew's npm install). npm then creates empty directories for zod and
// micromark instead of fetching them, and the CLI crashes on launch. The CLI
// already declares those packages as its own dependencies, so the bundled
// manifest's dependency lists are removed from the tarball: npm installs them
// for the CLI, and the bundled package resolves them from the same directory.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as tar from "tar";

const execFileAsync = promisify(execFile);
const pkgRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
// npm and pnpm stamp every packed file with this time so tarballs are reproducible.
const PACKED_MTIME = new Date("1985-10-26T08:15:00.000Z");
const UNSUPPORTED_BUNDLED_FIELDS = ["peerDependencies", "optionalDependencies"];

function nonEmpty(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

/**
 * Rewrites `tarball` in place so bundled packages declare no dependencies.
 * Throws when a bundled package needs something the CLI does not install
 * itself at the same range, because removing that edge would lose the package.
 */
export async function removeBundledDependencyEdges(tarball) {
  const workDir = await mkdtemp(join(tmpdir(), "matrix-cli-pack-"));
  try {
    await tar.x({ file: tarball, cwd: workDir });
    const packageDir = join(workDir, "package");
    const rootManifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    const bundledNames = rootManifest.bundledDependencies ?? rootManifest.bundleDependencies ?? [];
    const removed = [];

    for (const name of bundledNames) {
      const manifestPath = join(packageDir, "node_modules", ...name.split("/"), "package.json");
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (err) {
        if (err?.code === "ENOENT") {
          throw new Error(`Bundled dependency ${name} is missing from ${tarball}`);
        }
        throw err;
      }

      for (const field of UNSUPPORTED_BUNDLED_FIELDS) {
        if (nonEmpty(manifest[field])) {
          throw new Error(
            `Bundled dependency ${name} declares ${field}; the CLI cannot guarantee them after packing`,
          );
        }
      }

      const dependencies = manifest.dependencies ?? {};
      for (const [dependency, range] of Object.entries(dependencies)) {
        const cliRange = rootManifest.dependencies?.[dependency];
        if (cliRange !== range) {
          throw new Error(
            `Bundled dependency ${name} needs ${dependency}@${range}, but ${rootManifest.name} declares ` +
              `${cliRange === undefined ? "no such dependency" : `${dependency}@${cliRange}`}. ` +
              "Declare the same range in the CLI package.json.",
          );
        }
      }

      delete manifest.dependencies;
      delete manifest.devDependencies;
      for (const field of UNSUPPORTED_BUNDLED_FIELDS) delete manifest[field];
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      removed.push({ name, dependencies: Object.keys(dependencies).sort() });
    }

    const rewritten = join(dirname(tarball), `.${process.pid}.${Date.now()}.matrix-cli.tgz`);
    try {
      await tar.c(
        { gzip: true, file: rewritten, cwd: workDir, portable: true, mtime: PACKED_MTIME },
        ["package"],
      );
      await rename(rewritten, tarball);
    } catch (err) {
      await rm(rewritten, { force: true });
      throw err;
    }
    return removed;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Packs the CLI with the workspace-aware packer, then removes bundled
 * dependency edges. Returns pnpm's pack report plus the absolute tarball path.
 */
export async function packCli({ packDestination, env = process.env } = {}) {
  if (!packDestination) throw new Error("packCli requires packDestination");
  const destination = resolve(packDestination);
  await mkdir(destination, { recursive: true });
  // The hoisted linker materializes the private contracts package so it can be bundled.
  const { stdout } = await execFileAsync(
    "pnpm",
    ["pack", "--config.node-linker=hoisted", "--pack-destination", destination, "--json"],
    { cwd: pkgRoot, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const packInfo = JSON.parse(stdout);
  if (!packInfo || typeof packInfo.filename !== "string" || packInfo.filename.length === 0) {
    throw new Error("pnpm pack did not return a filename");
  }
  const tarball = resolve(destination, packInfo.filename);
  const removedBundledDependencies = await removeBundledDependencyEdges(tarball);
  return { ...packInfo, tarball, removedBundledDependencies };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flag = process.argv.indexOf("--pack-destination");
  const packDestination = flag === -1 ? undefined : process.argv[flag + 1];
  if (!packDestination) {
    console.error("Usage: pack-cli.mjs --pack-destination <dir>");
    process.exit(1);
  }
  const result = await packCli({ packDestination });
  console.log(JSON.stringify(result, null, 2));
}
