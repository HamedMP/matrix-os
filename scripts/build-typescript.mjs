// Keep the JavaScript compiler for declaration emit and compiler-API consumers.
// Incremental state is reusable only while every recorded output stays intact.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const STATE = ".matrix.tsbuildinfo";
const STAMP = ".matrix-build.json";
const LOCK = ".matrix-build.lock";
const MAX_FILES = 10000;
const MAX_BYTES = 128 * 1024 * 1024;

async function outputs(directory) {
  const files = [];
  let bytes = 0;
  async function walk(relative = "") {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Build output must not contain symbolic links");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const size = (await stat(join(directory, path))).size;
        bytes += size;
        if (files.length >= MAX_FILES || size > 16 * 1024 * 1024 || bytes > MAX_BYTES) {
          throw new Error("Build output exceeds incremental cache bounds");
        }
        const hash = createHash("sha256").update(await readFile(join(directory, path))).digest("hex");
        files.push([path, hash]);
      }
    }
  }
  await walk();
  return files.sort(([a], [b]) => a.localeCompare(b));
}

async function intact(directory, stamp) {
  try {
    const file = stamp;
    if ((await stat(file)).size > 2 * 1024 * 1024) return false;
    const previous = JSON.parse(await readFile(file, "utf8"));
    return previous.version === 1 && JSON.stringify(previous.files) === JSON.stringify(await outputs(directory));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function acquire(directory) {
  const lock = join(directory, LOCK);
  const deadline = Date.now() + 120000;
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "owner"), String(process.pid), { flag: "wx" });
      return async () => { await rm(lock, { recursive: true, force: true }); };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = join(lock, "owner");
        if ((await stat(owner)).size > 32) throw new Error("Invalid build lock owner");
        const pid = Number(await readFile(owner, "utf8"));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid build lock owner");
        try { process.kill(pid, 0); }
        catch (probe) {
          if (probe.code !== "ESRCH") throw probe;
          // Only one stale-owner inspector may reclaim a dead lock. A second
          // inspector must re-read the current owner after the first finishes.
          const reap = `${lock}.reap`;
          let acquired = false;
          try {
            await mkdir(reap);
            acquired = true;
            const current = Number(await readFile(join(lock, "owner"), "utf8"));
            if (current === pid) {
              try { process.kill(current, 0); }
              catch (currentProbe) {
                if (currentProbe.code !== "ESRCH") throw currentProbe;
                await rm(lock, { recursive: true, force: true });
              }
            }
          } catch (reapError) {
            if (!["ENOENT", "EEXIST"].includes(reapError.code)) throw reapError;
          } finally { if (acquired) await rm(reap, { recursive: true, force: true }); }
          if (Date.now() >= deadline) throw new Error("Stale build lock could not be reclaimed");
          await delay(100);
          continue;
        }
      } catch (ownerError) {
        if (ownerError.code !== "ENOENT") throw ownerError;
      }
      if (Date.now() >= deadline) throw new Error("Another package build still owns the incremental cache");
      await delay(100);
    }
  }
}

export async function buildTypescript(packageDirectory, compile) {
  const directory = join(packageDirectory, "dist");
  await mkdir(directory, { recursive: true });
  const cache = join(packageDirectory, ".matrix-build-cache");
  await mkdir(cache, { recursive: true });
  const release = await acquire(cache);
  const state = join(cache, STATE);
  const stamp = join(cache, STAMP);
  try {
    if (!await intact(directory, stamp)) await rm(state, { force: true });
    // TypeScript tracks inputs, imports, options and compiler version itself.
    // Always run it: an output fingerprint alone cannot prove source freshness.
    const status = await compile(["--project", "tsconfig.json", "--incremental", "--tsBuildInfoFile", state]);
    if (status !== 0) {
      await rm(state, { force: true });
      await rm(stamp, { force: true });
      return status;
    }
    const temporary = `${stamp}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, files: await outputs(directory) }), { flag: "wx" });
      await rename(temporary, stamp);
    } finally { await rm(temporary, { force: true }); }
    return 0;
  } catch (error) {
    await rm(state, { force: true });
    await rm(stamp, { force: true });
    throw error;
  } finally { await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.cwd();
  const require = createRequire(join(directory, "package.json"));
  const compiler = require.resolve("typescript/lib/tsc.js");
  const compile = (args) => new Promise((accept, reject) => {
    const child = spawn(process.execPath, [compiler, ...args], { cwd: directory, stdio: "inherit", timeout: 600000 });
    child.once("error", reject);
    child.once("exit", (code) => accept(code ?? 1));
  });
  process.exitCode = await buildTypescript(directory, compile);
}
