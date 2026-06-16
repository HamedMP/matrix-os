#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "../..");
const pkg = JSON.parse(await readFile(resolve(pkgRoot, "package.json"), "utf8"));
const version = process.env.MATRIX_CLI_VERSION || pkg.version;
const outDir = resolve(repoRoot, "dist", "cli-binaries");
const entry = resolve(pkgRoot, "src", "cli", "index.ts");

const targets = [
  { os: "linux", arch: "x64", bunTarget: "bun-linux-x64" },
  { os: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
  { os: "darwin", arch: "x64", bunTarget: "bun-darwin-x64" },
  { os: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
];

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        MATRIX_CLI_VERSION: version,
        MATRIX_CLI_STANDALONE: "1",
      },
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`));
    });
  });
}

await mkdir(outDir, { recursive: true });

await Promise.all(
  targets.map(async (target) => {
    const name = `matrix-${version}-${target.os}-${target.arch}`;
    const outfile = resolve(outDir, name);
    await run("bun", [
      "build",
      entry,
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--target",
      target.bunTarget,
      "--outfile",
      outfile,
      "--env",
      "MATRIX_CLI_*",
    ]);
    await chmod(outfile, 0o755);
    const sha256 = createHash("sha256").update(await readFile(outfile)).digest("hex");
    await writeFile(resolve(outDir, `${name}.sha256`), `${sha256}  ${name}\n`);
  }),
);

console.log(`Built Matrix CLI standalone binaries in ${outDir}`);
