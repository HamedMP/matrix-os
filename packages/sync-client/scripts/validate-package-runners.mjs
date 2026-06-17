#!/usr/bin/env node
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = await mkdtemp(join(tmpdir(), "matrix-cli-runners-"));

async function run(command, args, options = {}) {
  const runHome = options.home ?? join(tempRoot, "home");
  const pnpmHome = options.pnpmHome ?? join(tempRoot, "pnpm-home");
  await mkdir(runHome, { recursive: true });
  await mkdir(pnpmHome, { recursive: true });
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? pkgRoot,
      env: {
        ...process.env,
        HOME: runHome,
        PNPM_HOME: pnpmHome,
        npm_config_yes: "true",
        npm_config_update_notifier: "false",
        ...options.env,
      },
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
  const packDestination = join(tempRoot, "pack");
  await mkdir(packDestination, { recursive: true });
  const packed = await run("npm", ["pack", "--pack-destination", packDestination, "--json"], {
    home: join(tempRoot, "npm-pack-home"),
    pnpmHome: join(tempRoot, "npm-pack-pnpm-home"),
  });
  const [packInfo] = JSON.parse(packed.stdout);
  const tarball = join(packDestination, packInfo.filename);
  const files = new Set(packInfo.files.map((file) => file.path));
  for (const required of [
    "package.json",
    "bin/matrix.mjs",
    "src/cli/index.ts",
    "src/lib/find-tsx-loader.mjs",
    "src/lib/node-runtime-guard.mjs",
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

  console.log(`Package-runner validation: ok (${packInfo.name}@${packInfo.version})`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
