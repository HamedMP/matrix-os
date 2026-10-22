// Keep the JavaScript compiler for declaration emit and compiler-API consumers.
// Incremental state is reusable only while every recorded output stays intact.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
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
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const ORPHAN_AGE_MS = 120000;
const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const STAMP_TEMP = new RegExp(`^\\.matrix-build\\.json\\.${UUID}\\.tmp$`);
const PREPARED_LOCK = new RegExp(`^\\.matrix-build\\.lock(?:\\.reap)?\\.prepare\\.([1-9][0-9]*)\\.${UUID}$`);

async function* entries(directory) {
  let count = 0;
  for await (const entry of await opendir(directory)) {
    if (++count > MAX_FILES) throw new Error("Build cache directory exceeds entry bounds");
    yield entry;
  }
}

async function readManifest(path) {
  // A symbolic-link manifest fails closed (O_NOFOLLOW), rather than reading or
  // replacing an external target. Ordinary corrupt/oversized stamps rebuild.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null;
    // A writer cannot make readFile allocate an unbounded buffer after stat.
    const buffer = Buffer.alloc(info.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes !== info.size) return null;
    return buffer.subarray(0, bytes).toString("utf8");
  } finally { await file.close(); }
}

async function discardInvalidState(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_STATE_BYTES) {
      // rm unlinks a symlink itself; it never truncates the external target.
      await rm(path, { recursive: true, force: true });
      console.warn("Discarded nonregular or oversized incremental compiler state");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function owner(lock) {
  const file = join(lock, "owner");
  const info = await lstat(file);
  if (!info.isFile() || info.size > 32) throw new Error("Invalid build lock owner");
  const pid = Number(await readFile(file, "utf8"));
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid build lock owner");
  return pid;
}

async function compilerActive(lock) {
  const file = join(lock, "compiler");
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let pid;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 32) throw new Error("Invalid compiler owner");
      const bytes = Buffer.alloc(33);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      pid = Number(bytes.subarray(0, bytesRead).toString("utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid compiler owner");
    } finally { await handle.close(); }
    // A POSIX group survives a killed supervisor while an orphan compiler is
    // still writing. Windows crash records require manual recovery instead.
    if (process.platform === "win32") return true;
    try { process.kill(-pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function recoverEmptyLegacy(lock) {
  try {
    const info = await lstat(lock);
    if (!info.isDirectory()) throw new Error("Invalid build lock directory");
    if (Date.now() - info.mtimeMs < ORPHAN_AGE_MS) return;
    // Only remove EMPTY legacy locks. A newly published owner makes rmdir fail.
    await rmdir(lock);
    console.warn("Recovered an abandoned empty incremental build lock");
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

async function publishLock(lock) {
  // Populate a unique directory BEFORE atomically publishing it. rename cannot
  // replace another nonempty lock, so readers never observe an ownerless lock.
  const prepared = `${lock}.prepare.${process.pid}.${randomUUID()}`;
  await mkdir(prepared);
  try {
    await writeFile(join(prepared, "owner"), String(process.pid), { flag: "wx" });
    await rename(prepared, lock);
  } finally { await rm(prepared, { recursive: true, force: true }); }
}

async function sweep(directory) {
  for await (const entry of entries(directory)) {
    const path = join(directory, entry.name);
    if (STAMP_TEMP.test(entry.name)) {
      // The primary lock guarantees no active stamp writer. rm unlinks symlinks.
      if (!entry.isDirectory()) await rm(path, { force: true });
      continue;
    }
    const prepared = PREPARED_LOCK.exec(entry.name);
    if (!prepared) continue;
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const pid = Number(prepared[1]);
    if (Date.now() - info.mtimeMs >= ORPHAN_AGE_MS && !alive(pid)) {
      await rm(path, { recursive: true, force: true });
      console.warn("Removed abandoned incremental build lock preparation");
    }
  }
}

async function outputs(directory) {
  const files = [];
  let bytes = 0;
  let visited = 0;
  let manifestBytes = Buffer.byteLength('{"version":1,"files":[]}');
  async function walk(relative = "", depth = 0) {
    if (depth > 128) throw new Error("Build output exceeds directory depth bounds");
    for await (const entry of entries(join(directory, relative))) {
      if (++visited > MAX_FILES) throw new Error("Build output exceeds entry bounds");
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Build output must not contain symbolic links");
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) {
        const size = (await stat(join(directory, path))).size;
        bytes += size;
        if (files.length >= MAX_FILES || size > 16 * 1024 * 1024 || bytes > MAX_BYTES) {
          throw new Error("Build output exceeds incremental cache bounds");
        }
        const hash = createHash("sha256").update(await readFile(join(directory, path))).digest("hex");
        const record = [path, hash];
        manifestBytes += Buffer.byteLength(JSON.stringify(record)) + (files.length ? 1 : 0);
        if (manifestBytes > MAX_MANIFEST_BYTES) throw new Error("Build output manifest exceeds byte bounds");
        files.push(record);
      }
    }
  }
  await walk();
  return files.sort(([a], [b]) => a.localeCompare(b));
}

async function intact(directory, stamp) {
  try {
    const contents = await readManifest(stamp);
    if (contents === null) return false;
    const previous = JSON.parse(contents);
    if (!previous || typeof previous !== "object" || previous.version !== 1 || !Array.isArray(previous.files)
      || previous.files.length > MAX_FILES || !previous.files.every(record => Array.isArray(record)
        && record.length === 2 && typeof record[0] === "string" && typeof record[1] === "string"
        && /^[a-f0-9]{64}$/.test(record[1]))) return false;
    return JSON.stringify(previous.files) === JSON.stringify(await outputs(directory));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    if (error instanceof SyntaxError) {
      console.warn("Discarded a malformed incremental build manifest");
      return false;
    }
    throw error;
  }
}

async function acquire(directory) {
  const lock = join(directory, LOCK);
  const reap = `${lock}.reap`;
  const deadline = performance.now() + 120000;
  while (true) {
    try {
      if (!(await lstat(lock)).isDirectory()) throw new Error("Invalid build lock directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        await publishLock(lock);
        return async () => {
          if (await compilerActive(lock)) throw new Error("Compiler still owns the incremental cache");
          if (await owner(lock) !== process.pid) throw new Error("Incremental build lock ownership changed");
          await rm(lock, { recursive: true, force: true });
        };
      } catch (publishError) {
        if (!["EEXIST", "ENOTEMPTY"].includes(publishError.code)) throw publishError;
      }
    }
    try {
      const pid = await owner(lock);
      if (!alive(pid) && !await compilerActive(lock)) {
        await recoverEmptyLegacy(reap);
        let acquired = false;
        try {
          // A populated abandoned reaper fails closed: recursively stealing
          // its guard could remove a newly active primary lock. The deadline
          // bounds the wait; an operator may remove it after all builds stop.
          try {
            if (!(await lstat(reap)).isDirectory()) throw new Error("Invalid build reaper directory");
          }
          catch (error) {
            if (error.code !== "ENOENT") throw error;
            await publishLock(reap);
            acquired = true;
          }
          if (acquired && await owner(lock) === pid && !alive(pid) && !await compilerActive(lock)) {
            await rm(lock, { recursive: true, force: true });
            console.warn("Recovered an incremental build lock with a dead owner");
          }
        } catch (error) {
          if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        } finally { if (acquired) await rm(reap, { recursive: true, force: true }); }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await recoverEmptyLegacy(lock);
    }
    if (performance.now() >= deadline) throw new Error("Another package build or reaper still owns the incremental cache");
    await delay(100);
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
    await sweep(cache);
    await discardInvalidState(state);
    if (!await intact(directory, stamp)) await rm(state, { force: true });
    // TypeScript tracks inputs, imports, options and compiler version itself.
    // Always run it: an output fingerprint alone cannot prove source freshness.
    const status = await compile(["--project", "tsconfig.json", "--incremental", "--tsBuildInfoFile", state], { lock: join(cache, LOCK) });
    if (status !== 0) {
      await rm(state, { force: true });
      await rm(stamp, { force: true });
      return status;
    }
    // Successful emit remains valid even when its optional warm state is too
    // large or unsafe to reuse; the next build simply invokes a cold compiler.
    await discardInvalidState(state);
    const temporary = `${stamp}.${randomUUID()}.tmp`;
    try {
      const manifest = JSON.stringify({ version: 1, files: await outputs(directory) });
      if (Buffer.byteLength(manifest) > MAX_MANIFEST_BYTES) throw new Error("Build output manifest exceeds byte bounds");
      await writeFile(temporary, manifest, { flag: "wx" });
      await rename(temporary, stamp);
    } finally { await rm(temporary, { force: true }); }
    return 0;
  } catch (error) {
    await rm(state, { force: true });
    await rm(stamp, { force: true });
    throw error;
  } finally { await release(); }
}

function superviseCompiler(directory, compiler, args) {
  let child, timer, escalation, stopping = false, finished = false, status = 1;
  const stop = (code = 143) => {
    if (finished) return;
    status = code;
    stopping = true;
    if (!child) { finished = true; process.exitCode = status; process.disconnect(); return; }
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => child.kill("SIGKILL"), 5000);
  };
  process.once("disconnect", () => stop());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(signal === "SIGINT" ? 130 : 143));
  process.once("message", message => {
    if (stopping || message?.type !== "start") return stop();
    child = spawn(process.execPath, [compiler, ...args], { cwd: directory, stdio: "inherit" });
    timer = setTimeout(() => stop(124), 600000);
    child.once("error", error => { console.error("Compiler process failed:", error.code ?? "unknown"); status = 1; });
    child.once("close", code => {
      finished = true;
      clearTimeout(timer); clearTimeout(escalation);
      process.exitCode = stopping ? status : (code ?? 1);
      if (process.connected) process.send({ type: "stopped" }, () => process.disconnect());
    });
  });
  process.send({ type: "ready" });
}

async function ownedCompiler(directory, compiler, args, lock) {
  return await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve(process.argv[1]), "--compiler-supervisor", directory, compiler, ...args],
      { cwd: directory, stdio: ["inherit", "inherit", "inherit", "ipc"], detached: process.platform !== "win32" });
    let preparation = Promise.resolve(), failure, stopped = false, cancellation;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const cancel = signal => { cancellation ??= signal === "SIGINT" ? 130 : 143; child.kill("SIGTERM"); };
    const listeners = signals.map(signal => () => cancel(signal));
    signals.forEach((signal, index) => process.on(signal, listeners[index]));
    child.on("message", message => {
      if (message?.type === "stopped") stopped = true;
      if (message?.type !== "ready") return;
      preparation = writeFile(join(lock, "compiler"), String(child.pid), { flag: "wx" }).then(() => {
        if (!cancellation && child.connected) child.send({ type: "start" });
      }).catch(error => { failure = error; child.kill("SIGTERM"); });
    });
    child.once("error", error => { failure = error; });
    child.once("close", async code => {
      try {
        await preparation;
        if (process.platform !== "win32" && await compilerActive(lock)) {
          // A killed supervisor can leave descendants behind. Never release its
          // lock until the whole recorded process group is independently gone.
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
          const deadline = performance.now() + 5000;
          while (await compilerActive(lock) && performance.now() < deadline) await delay(20);
          if (await compilerActive(lock)) throw new Error("Compiler process group cleanup is uncertain");
        } else if (process.platform === "win32" && !stopped && await compilerActive(lock)) {
          throw new Error("Compiler cleanup is uncertain; retain ownership for recovery");
        }
        await rm(join(lock, "compiler"), { force: true });
        if (failure) throw failure;
        accept(cancellation ?? code ?? 1);
      } catch (error) { reject(error); }
      finally { signals.forEach((signal, index) => process.off(signal, listeners[index])); }
    });
  });
}

if (process.argv[2] === "--compiler-supervisor") {
  superviseCompiler(process.argv[3], process.argv[4], process.argv.slice(5));
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.cwd();
  const require = createRequire(join(directory, "package.json"));
  const compiler = require.resolve("typescript/lib/tsc.js");
  const compile = (args, { lock }) => ownedCompiler(directory, compiler, args, lock);
  process.exitCode = await buildTypescript(directory, compile);
}
