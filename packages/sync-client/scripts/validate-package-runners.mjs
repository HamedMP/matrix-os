#!/usr/bin/env node
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packCli } from "./pack-cli.mjs";

const pkgRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = await mkdtemp(join(tmpdir(), "matrix-cli-runners-"));

async function isolatedEnv(options = {}) {
  const runHome = options.home ?? join(tempRoot, "home");
  const pnpmHome = options.pnpmHome ?? join(tempRoot, "pnpm-home");
  await mkdir(runHome, { recursive: true });
  await mkdir(pnpmHome, { recursive: true });
  return {
    ...process.env,
    HOME: runHome,
    PNPM_HOME: pnpmHome,
    npm_config_yes: "true",
    npm_config_update_notifier: "false",
    ...options.env,
  };
}

async function run(command, args, options = {}) {
  const env = await isolatedEnv(options);
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? pkgRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killTimer;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref?.();
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})\n${stdout}${stderr}`));
    });
  });
}

try {
  // Use the same packer as publication, including private contracts.
  const packInfo = await packCli({
    packDestination: join(tempRoot, "pack"),
    env: await isolatedEnv({
      home: join(tempRoot, "npm-pack-home"),
      pnpmHome: join(tempRoot, "npm-pack-pnpm-home"),
    }),
  });
  const tarball = packInfo.tarball;
  const files = new Set(packInfo.files.map((file) => file.path));
  for (const required of [
    "package.json",
    "bin/matrix.mjs",
    "src/cli/index.ts",
    "src/lib/find-tsx-loader.mjs",
    "src/lib/node-runtime-guard.mjs",
    "node_modules/@matrix-os/contracts/package.json",
    "node_modules/@matrix-os/contracts/src/collaboration.ts",
  ]) {
    if (!files.has(required)) {
      throw new Error(`Packed package is missing ${required}`);
    }
  }

  const npmRun = await run("npm", ["exec", "--yes", "--package", tarball, "--", "matrix", "--version"], {
    home: join(tempRoot, "npm-exec-home"),
    pnpmHome: join(tempRoot, "npm-exec-pnpm-home"),
  });
  const npmOutput = npmRun.stdout + npmRun.stderr;
  if (!npmOutput.includes(packInfo.version)) {
    throw new Error(`npm exec did not print ${packInfo.version}: ${npmOutput}`);
  }

  const pnpmRun = await run("pnpm", ["dlx", `file:${tarball}`, "--version"], {
    home: join(tempRoot, "pnpm-dlx-home"),
    pnpmHome: join(tempRoot, "pnpm-dlx-pnpm-home"),
  });
  const pnpmOutput = pnpmRun.stdout + pnpmRun.stderr;
  if (!pnpmOutput.includes(packInfo.version)) {
    throw new Error(`pnpm dlx did not print ${packInfo.version}: ${pnpmOutput}`);
  }

  // `npm install -g` nests every dependency under the CLI, the layout in which
  // npm skips dependencies it believes are bundled. Run outside the workspace
  // so nothing resolves from the repo's own node_modules. On macOS this is
  // also the step that fails if fsevents stops being an optional dependency
  // of the CLI, so the release workflows run it there too.
  const globalPrefix = join(tempRoot, "npm-global-prefix");
  await run("npm", ["install", "--global", "--prefix", globalPrefix, tarball], {
    cwd: tempRoot,
    home: join(tempRoot, "npm-global-home"),
    pnpmHome: join(tempRoot, "npm-global-pnpm-home"),
  });
  const globalRun = await run(join(globalPrefix, "bin", "matrix"), ["--version"], {
    cwd: tempRoot,
    home: join(tempRoot, "npm-global-home"),
    pnpmHome: join(tempRoot, "npm-global-pnpm-home"),
  });
  const globalOutput = globalRun.stdout + globalRun.stderr;
  if (!globalOutput.includes(packInfo.version)) {
    throw new Error(`npm install -g did not print ${packInfo.version}: ${globalOutput}`);
  }

  console.log(`Package-runner validation: ok (${packInfo.name}@${packInfo.version})`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
