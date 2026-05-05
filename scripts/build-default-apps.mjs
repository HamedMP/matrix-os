#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { glob, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const appsRoot = resolve(process.argv[2] ?? join(root, "home/apps"));
const rootBin = join(root, "node_modules/.bin");

function run(command, cwd, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        PATH: `${rootBin}:${process.env.PATH ?? ""}`,
      },
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else reject(new Error(`Command failed with exit ${code}: ${command}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function hashSources(appDir, patterns) {
  const files = [];
  for (const pattern of patterns) {
    for await (const match of glob(pattern, { cwd: appDir })) {
      const abs = join(appDir, match);
      const st = await stat(abs).catch((err) => {
        if (err?.code === "ENOENT") return null;
        throw err;
      });
      if (st?.isFile()) files.push(abs);
    }
  }
  files.sort((a, b) => relative(appDir, a).localeCompare(relative(appDir, b)));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(appDir, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function hashLockfile(appDir) {
  const lockfile = await readFile(join(appDir, "pnpm-lock.yaml")).catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  return lockfile ? createHash("sha256").update(lockfile).digest("hex") : "";
}

async function buildApp(manifestPath) {
  const appDir = dirname(manifestPath);
  if (relative(appsRoot, appDir).split(/[\\/]/).some((part) => part.startsWith("_"))) {
    return;
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.runtime !== "vite" || !manifest.build) return;

  const slug = manifest.slug ?? relative(appsRoot, appDir).replaceAll("\\", "/");
  const timeoutMs = Number(manifest.build.timeout ?? 180) * 1000;
  const install = manifest.build.install ?? "true";
  const command = manifest.build.command;
  const output = manifest.build.output ?? "dist";
  if (!command) throw new Error(`${manifestPath} is missing build.command`);

  console.log(`[default-apps] building ${slug}`);
  if (install !== "true") {
    await run(install, appDir, timeoutMs);
  }
  await run(command, appDir, timeoutMs);

  await stat(join(appDir, output, "index.html"));
  const sourceGlobs = manifest.build.sourceGlobs ?? ["src/**", "public/**", "*.config.*", "index.html", "matrix.json"];
  await writeFile(
    join(appDir, ".build-stamp"),
    JSON.stringify(
      {
        sourceHash: await hashSources(appDir, sourceGlobs),
        lockfileHash: await hashLockfile(appDir),
        builtAt: Date.now(),
        exitCode: 0,
      },
      null,
      2,
    ),
  );
}

await mkdir(appsRoot, { recursive: true });
const manifests = [];
for await (const file of glob("**/matrix.json", { cwd: appsRoot })) {
  manifests.push(join(appsRoot, file));
}
manifests.sort();
for (const manifestPath of manifests) {
  await buildApp(manifestPath);
}
