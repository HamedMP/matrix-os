#!/usr/bin/env node
// Packs the publishable CLI tarball. Every release and validation path must
// use this instead of a bare `pnpm pack`.
//
// The CLI ships the private `@matrix-os/contracts` workspace package inside
// its tarball. `bundledDependencies` is what makes `pnpm pack` include those
// files, but npm mishandles a globally installed package that declares it
// (`npm install -g`, Homebrew's npm install):
//   - it assumes the bundled package's dependencies are in the bundle too and
//     installs empty zod and micromark directories, so the CLI crashes; and
//   - it runs install scripts as if for bundled packages, so the optional
//     fsevents build that every macOS install tolerates becomes fatal.
// The published manifest therefore drops the declaration and the contracts
// dependency entry. The files stay at node_modules/@matrix-os/contracts, where
// Node resolves them, and npm installs every real dependency for the CLI.
// Contracts resolves its own imports from the CLI's dependencies, so each of
// them must be declared by the CLI at the same range.
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
 * Rewrites `tarball` in place so packages listed in `bundledDependencies` are
 * shipped as plain files instead of declared bundled dependencies. Throws when
 * a bundled package needs something the CLI does not install itself at the
 * same range, because nothing else would install it.
 */
export async function vendorBundledDependencies(tarball) {
  const workDir = await mkdtemp(join(tmpdir(), "matrix-cli-pack-"));
  try {
    await tar.x({ file: tarball, cwd: workDir });
    const packageDir = join(workDir, "package");
    const rootManifestPath = join(packageDir, "package.json");
    const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
    const bundledNames = rootManifest.bundledDependencies ?? rootManifest.bundleDependencies ?? [];
    const vendored = [];

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
      vendored.push({ name, dependencies: Object.keys(dependencies).sort() });
    }

    delete rootManifest.bundledDependencies;
    delete rootManifest.bundleDependencies;
    for (const { name } of vendored) delete rootManifest.dependencies?.[name];
    await writeFile(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`);

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
    return vendored;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Packs the CLI with the workspace-aware packer, then vendors its bundled
 * dependencies. Returns pnpm's pack report plus the absolute tarball path.
 */
export async function packCli({ packDestination, env = process.env } = {}) {
  if (!packDestination) throw new Error("packCli requires packDestination");
  const destination = resolve(packDestination);
  await mkdir(destination, { recursive: true });
  // The hoisted linker materializes the private contracts package so it can be packed.
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
  const vendoredDependencies = await vendorBundledDependencies(tarball);
  return { ...packInfo, tarball, vendoredDependencies };
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
