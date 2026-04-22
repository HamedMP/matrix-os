#!/usr/bin/env node
// Bundles the Matrix OS CLI into a single JS file and packs a tarball for release.
// Output: dist/cli/matrix-cli-<version>.tar.gz
//
// Usage:
//   node --import tsx scripts/build-cli.ts           # builds dist/cli/
//   node --import tsx scripts/build-cli.ts --pack    # also produces the tarball
//
// Run via `pnpm build:cli` / `pnpm pack:cli`.

import { mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..");
const outRoot = join(rootDir, "dist", "cli");
const stageDir = join(outRoot, "stage");
const binDir = join(stageDir, "bin");

const rootPkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8"));
const version: string = rootPkg.version ?? "0.0.0";
const shouldPack = process.argv.includes("--pack");

const entry = join(rootDir, "packages", "sync-client", "src", "cli", "index.ts");
if (!existsSync(entry)) {
  console.error(`missing entry: ${entry}`);
  process.exit(1);
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });

const outFile = join(binDir, "matrix.js");
const esbuild = join(rootDir, "node_modules", ".bin", "esbuild");
if (!existsSync(esbuild)) {
  console.error(`esbuild not found at ${esbuild}; run \`pnpm install\` first`);
  process.exit(1);
}

const result = spawnSync(
  esbuild,
  [
    entry,
    "--bundle",
    "--platform=node",
    "--target=node20",
    "--format=esm",
    `--outfile=${outFile}`,
    "--banner:js=#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    "--legal-comments=none",
    `--define:__MATRIX_CLI_VERSION__=${JSON.stringify(version)}`,
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

chmodSync(outFile, 0o755);

const wrapper = (target: string) => `#!/bin/sh
MATRIX_CLI_NAME="$(basename "$0")" exec node "$(dirname "$0")/${target}" "$@"
`;
for (const name of ["matrix", "matrixos", "mos"]) {
  const p = join(binDir, name);
  writeFileSync(p, wrapper("matrix.js"));
  chmodSync(p, 0o755);
}

const distPkg = {
  name: "@finnaai/matrix",
  version,
  type: "module",
  bin: {
    matrix: "./bin/matrix",
    matrixos: "./bin/matrixos",
    mos: "./bin/mos",
  },
  engines: { node: ">=20" },
  license: rootPkg.license ?? "AGPL-3.0-or-later",
};
writeFileSync(join(stageDir, "package.json"), JSON.stringify(distPkg, null, 2));

writeFileSync(
  join(stageDir, "README.md"),
  `# Matrix OS CLI

Installed via \`brew install finnaai/tap/matrix\` or \`curl -fsSL https://matrix-os.com/install | sh\`.

Run \`matrix help\` for usage.
`,
);

const sizeKB = (statSync(outFile).size / 1024).toFixed(1);
console.log(`built: ${outFile} (${sizeKB} KB)`);

if (shouldPack) {
  const tarball = join(outRoot, `matrix-cli-${version}.tar.gz`);
  const tar = spawnSync("tar", ["-czf", tarball, "-C", outRoot, "stage"], { stdio: "inherit" });
  if (tar.status !== 0) process.exit(tar.status ?? 1);

  let digest = "";
  const sha = spawnSync("sha256sum", [tarball], { encoding: "utf-8" });
  if (sha.status === 0) {
    digest = (sha.stdout ?? "").split(/\s+/)[0];
  } else {
    const sha2 = spawnSync("shasum", ["-a", "256", tarball], { encoding: "utf-8" });
    if (sha2.status === 0) digest = (sha2.stdout ?? "").split(/\s+/)[0];
  }
  if (digest) {
    writeFileSync(`${tarball}.sha256`, `${digest}  matrix-cli-${version}.tar.gz\n`);
  }
  console.log(`packed: ${tarball}`);
  if (digest) console.log(`sha256: ${digest}`);
}
