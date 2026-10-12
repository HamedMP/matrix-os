import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTypescript } from "../../scripts/build-typescript.mjs";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "matrix-incremental-test-"));
  directories.push(directory);
  await mkdir(join(directory, "dist"));
  await writeFile(join(directory, "dist/index.js"), "export const value = 1;\n");
  return directory;
}

interface LockObservation {
  observedPath: string;
  startupDelayMs?: number;
  startupTimeoutMs?: number;
}
async function subprocessBuild(directory: string, timeout = 2000, observation?: LockObservation) {
  const script = new URL("../../scripts/build-typescript.mjs", import.meta.url).href;
  if (!observation) {
    const source = `import { buildTypescript } from ${JSON.stringify(script)};
      process.exitCode = await buildTypescript(${JSON.stringify(directory)}, async () => 0);`;
    return await subprocess(source, timeout);
  }
  const source = `import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    await new Promise(resolve => setTimeout(resolve, ${observation.startupDelayMs ?? 0}));
    let observed = false;
    // Observe successful real acquire I/O, never merely entry into the wrapper.
    for (const method of ["lstat", "readFile"]) {
      const original = fs[method];
      fs[method] = async (path, ...args) => {
        const value = await original(path, ...args);
        if (!observed && String(path) === ${JSON.stringify(observation.observedPath)} &&
            method === ${JSON.stringify(observation.observedPath.endsWith('/owner') ? 'readFile' : 'lstat')}) {
          observed = true;
          process.send({ type: "lock-observed", path: String(path) });
        }
        return value;
      };
    }
    syncBuiltinESMExports();
    const { buildTypescript } = await import(${JSON.stringify(script)});
    try { process.exitCode = await buildTypescript(${JSON.stringify(directory)}, async () => 0); }
    finally { if (process.connected) process.disconnect(); }`;
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null; lockObserved: boolean }>((accept, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let lockObserved = false;
    let failure: Error | undefined;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      escalation ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const startup = setTimeout(() => {
      failure = new Error("Lock observation startup deadline"); stop();
    }, observation.startupTimeoutMs ?? 5000);
    child.once("error", error => { failure = error; stop(); });
    child.on("message", message => {
      const event = message as { type?: string; path?: string };
      if (failure || lockObserved || event.type !== "lock-observed" || event.path !== observation.observedPath) return;
      lockObserved = true;
      clearTimeout(startup);
      waiting = setTimeout(stop, timeout);
    });
    // Await close after either deadline, so no child outlives temporary fixtures.
    child.once("close", (code, signal) => {
      clearTimeout(startup); clearTimeout(waiting); clearTimeout(escalation);
      if (failure) reject(failure);
      else if (!lockObserved) reject(new Error("Child exited before actual lock observation"));
      else accept({ code, signal, lockObserved });
    });
  });
}

async function subprocess(source: string, timeout = 2000) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: "ignore", timeout });
    child.once("error", reject);
    child.once("exit", (code, signal) => accept({ code, signal }));
  });
}

describe("incremental shared TypeScript builds", () => {
  it("checks changed source and repairs deleted emit with the real JavaScript compiler", async () => {
    const directory = await fixture();
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      outDir: "dist", rootDir: "src", types: [], strict: true, target: "ES2022", skipLibCheck: true,
    }, include: ["src"] }));
    await writeFile(join(directory, "src/index.ts"), "export const value: number = 1;\n");
    const compiler = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
    const compile = (args: string[]) => new Promise<number>((accept, reject) => {
      const child = spawn(process.execPath, [compiler, ...args], { cwd: directory, stdio: "ignore", timeout: 15000 });
      child.once("error", reject);
      child.once("exit", code => accept(code ?? 1));
    });
    expect(await buildTypescript(directory, compile)).toBe(0);
    await rm(join(directory, "dist/index.js"));
    expect(await buildTypescript(directory, compile)).toBe(0);
    expect(await readFile(join(directory, "dist/index.js"), "utf8")).toContain("value = 1");
    await writeFile(join(directory, "src/index.ts"), 'export const value: number = "wrong";\n');
    expect(await buildTypescript(directory, compile)).not.toBe(0);
  });

  it("serializes competing builds of the same package", async () => {
    const directory = await fixture();
    let active = 0;
    let maximum = 0;
    const compile = async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise(accept => setTimeout(accept, 25));
      active--;
      return 0;
    };
    expect(await Promise.all([buildTypescript(directory, compile), buildTypescript(directory, compile)])).toEqual([0, 0]);
    expect(maximum).toBe(1);
  });

  it("reclaims a dead build owner without admitting competing cache writers", async () => {
    const directory = await fixture();
    const lock = join(directory, ".matrix-build-cache/.matrix-build.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner"), "2147483647");
    let active = 0;
    let maximum = 0;
    const compile = async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise(accept => setTimeout(accept, 25));
      active--;
      return 0;
    };
    expect(await Promise.all([buildTypescript(directory, compile), buildTypescript(directory, compile)])).toEqual([0, 0]);
    expect(maximum).toBe(1);
  });

  it.each(["primary", "reaper"])("recovers an aged ownerless legacy %s lock", async kind => {
    const directory = await fixture();
    const lock = join(directory, ".matrix-build-cache/.matrix-build.lock");
    await mkdir(lock, { recursive: true });
    if (kind === "reaper") {
      await writeFile(join(lock, "owner"), "2147483647");
      await mkdir(`${lock}.reap`);
    }
    const abandoned = kind === "primary" ? lock : `${lock}.reap`;
    await utimes(abandoned, new Date(0), new Date(0));
    expect(await subprocessBuild(directory)).toEqual({ code: 0, signal: null });
  });

  it.each(["primary", "reaper"])("waits for the actual %s lock observation before timing a delayed child", async kind => {
    const directory = await fixture();
    const lock = join(directory, ".matrix-build-cache/.matrix-build.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner"), kind === "primary" ? String(process.pid) : "2147483647");
    if (kind === "reaper") {
      await mkdir(`${lock}.reap`);
      await writeFile(join(`${lock}.reap`, "owner"), String(process.pid));
    }
    const observedPath = kind === "primary" ? join(lock, "owner") : `${lock}.reap`;
    const started = performance.now();
    const result = await subprocessBuild(directory, 250, { observedPath, startupDelayMs: 400 });
    expect(result).toMatchObject({ signal: "SIGTERM", lockObserved: true });
    expect(performance.now() - started).toBeGreaterThanOrEqual(650);
    expect(await readFile(join(lock, "owner"), "utf8")).toBe(kind === "primary" ? String(process.pid) : "2147483647");
  });

  it("fails startup separately when a child has not reached the lock observation", async () => {
    const directory = await fixture();
    const lock = join(directory, ".matrix-build-cache/.matrix-build.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner"), String(process.pid));
    await expect(subprocessBuild(directory, 250, {
      observedPath: join(lock, "owner"), startupDelayMs: 400, startupTimeoutMs: 50,
    })).rejects.toThrow("Lock observation startup deadline");
    expect(await readFile(join(lock, "owner"), "utf8")).toBe(String(process.pid));
  });

  it("does not reclaim an aged lock whose owner is still alive", async () => {
    const directory = await fixture();
    const lock = join(directory, ".matrix-build-cache/.matrix-build.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner"), String(process.pid));
    await utimes(lock, new Date(0), new Date(0));
    expect(await subprocessBuild(directory, 250, { observedPath: join(lock, "owner") })).toMatchObject({ signal: "SIGTERM", lockObserved: true });
    expect(await readFile(join(lock, "owner"), "utf8")).toBe(String(process.pid));
  });

  it.each([process.pid, 2147483647])("leaves a populated reaper owned by PID %i fail-closed", async pid => {
    const directory = await fixture();
    const lock = join(directory, ".matrix-build-cache/.matrix-build.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner"), "2147483647");
    await mkdir(`${lock}.reap`);
    await writeFile(join(`${lock}.reap`, "owner"), String(pid));
    await utimes(`${lock}.reap`, new Date(0), new Date(0));
    expect(await subprocessBuild(directory, 250, { observedPath: `${lock}.reap` })).toMatchObject({ signal: "SIGTERM", lockObserved: true });
    expect(await readFile(join(lock, "owner"), "utf8")).toBe("2147483647");
    expect(await readFile(join(`${lock}.reap`, "owner"), "utf8")).toBe(String(pid));
  });

  it("a crash before owner metadata publication leaves no primary lock and its preparation is swept", async () => {
    const directory = await fixture();
    const script = new URL("../../scripts/build-typescript.mjs", import.meta.url).href;
    // Crash at the exact old mkdir/owner gap, using a real child process.
    const source = `import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const original = fs.writeFile;
      fs.writeFile = async (path, ...args) => {
        if (String(path).endsWith("/owner")) process.exit(99);
        return original(path, ...args);
      };
      syncBuiltinESMExports();
      const { buildTypescript } = await import(${JSON.stringify(script)});
      await buildTypescript(${JSON.stringify(directory)}, async () => 0);`;
    expect(await subprocess(source)).toEqual({ code: 99, signal: null });
    const cache = join(directory, ".matrix-build-cache");
    const abandoned = await readdir(cache);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatch(/^\.matrix-build\.lock\.prepare\.[1-9][0-9]*\.[a-f0-9-]+$/);
    await utimes(join(cache, abandoned[0]), new Date(0), new Date(0));
    expect(await subprocessBuild(directory)).toEqual({ code: 0, signal: null });
    expect(await readdir(cache)).toEqual([".matrix-build.json"]);
  });

  it("always invokes the compiler and reuses its state only with intact output", async () => {
    const directory = await fixture();
    let calls = 0;
    const compile = async (args: string[]) => {
      expect(args).toContain("--incremental");
      const state = args[args.indexOf("--tsBuildInfoFile") + 1];
      if (calls++) expect(await readFile(state, "utf8")).toBe("compiler-state");
      await writeFile(state, "compiler-state");
      return 0;
    };
    await buildTypescript(directory, compile);
    await buildTypescript(directory, compile);
    expect(calls).toBe(2);
  });

  it.each(["removed", "corrupted"])("rebuilds %s output instead of trusting stale incremental state", async (mode) => {
    const directory = await fixture();
    let calls = 0;
    const compile = async (args: string[]) => {
      const state = args[args.indexOf("--tsBuildInfoFile") + 1];
      if (calls++) await expect(readFile(state)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(join(directory, "dist/index.js"), "export const value = 1;\n");
      await writeFile(state, "compiler-state");
      return 0;
    };
    await buildTypescript(directory, compile);
    if (mode === "removed") await rm(join(directory, "dist/index.js"));
    else await writeFile(join(directory, "dist/index.js"), "broken");
    await buildTypescript(directory, compile);
    expect(calls).toBe(2);
  });

  it("propagates compiler failure and invalidates its state before the next build", async () => {
    const directory = await fixture();
    const compile = async (args: string[]) => {
      await writeFile(args[args.indexOf("--tsBuildInfoFile") + 1], "partial");
      return 2;
    };
    expect(await buildTypescript(directory, compile)).toBe(2);
    await expect(readFile(join(directory, ".matrix-build-cache/.matrix.tsbuildinfo"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["null", "[]", '{"version":1,"files":null}', '{"version":1,"files":[[null,"hash"]]}'])(
    "rebuilds after an invalid manifest shape: %s", async (manifest) => {
      const directory = await fixture();
      const cache = join(directory, ".matrix-build-cache");
      await mkdir(cache);
      await writeFile(join(cache, ".matrix-build.json"), manifest);
      await writeFile(join(cache, ".matrix.tsbuildinfo"), "stale");
      let calls = 0;
      expect(await buildTypescript(directory, async () => {
        calls++;
        await expect(readFile(join(cache, ".matrix.tsbuildinfo"))).rejects.toMatchObject({ code: "ENOENT" });
        return 0;
      })).toBe(0);
      expect(calls).toBe(1);
    },
  );

  it("sweeps orphan stamp writes on every build without following symlinks or deleting unrelated files", async () => {
    const directory = await fixture();
    const cache = join(directory, ".matrix-build-cache");
    await mkdir(cache);
    const orphan = ".matrix-build.json.00000000-0000-4000-8000-000000000000.tmp";
    const unrelated = ".matrix-build.json.keep.tmp";
    await writeFile(join(cache, unrelated), "keep");
    await writeFile(join(directory, "outside"), "untouched");
    for (let run = 0; run < 2; run++) {
      if (run) await symlink(join(directory, "outside"), join(cache, orphan));
      else await writeFile(join(cache, orphan), "incomplete");
      expect(await buildTypescript(directory, async () => 0)).toBe(0);
      expect(await readdir(cache)).not.toContain(orphan);
      expect(await readFile(join(cache, unrelated), "utf8")).toBe("keep");
      expect(await readFile(join(directory, "outside"), "utf8")).toBe("untouched");
    }
  });

  it("rebuilds after an oversized stored manifest instead of parsing it", async () => {
    const directory = await fixture();
    const cache = join(directory, ".matrix-build-cache");
    await mkdir(cache);
    await writeFile(join(cache, ".matrix-build.json"), " ".repeat(2 * 1024 * 1024 + 1));
    await writeFile(join(cache, ".matrix.tsbuildinfo"), "stale");
    expect(await buildTypescript(directory, async () => {
      await expect(readFile(join(cache, ".matrix.tsbuildinfo"))).rejects.toMatchObject({ code: "ENOENT" });
      return 0;
    })).toBe(0);
  });

  it.each(["oversized", "symlink"])("invalidates %s compiler state before starting the compiler", async mode => {
    const directory = await fixture();
    await buildTypescript(directory, async () => 0);
    const state = join(directory, ".matrix-build-cache/.matrix.tsbuildinfo");
    const outside = join(directory, "outside-state");
    await writeFile(outside, "untouched");
    if (mode === "symlink") await symlink(outside, state);
    else {
      await writeFile(state, "");
      await truncate(state, 16 * 1024 * 1024 + 1);
    }
    expect(await buildTypescript(directory, async () => {
      await expect(lstat(state)).rejects.toMatchObject({ code: "ENOENT" });
      return 0;
    })).toBe(0);
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });

  it.each(["oversized", "symlink"])("discards %s newly emitted compiler state while retaining successful output", async mode => {
    const directory = await fixture();
    const state = join(directory, ".matrix-build-cache/.matrix.tsbuildinfo");
    const outside = join(directory, "outside-state");
    await writeFile(outside, "untouched");
    expect(await buildTypescript(directory, async () => {
      if (mode === "symlink") await symlink(outside, state);
      else {
        await writeFile(state, "");
        await truncate(state, 16 * 1024 * 1024 + 1);
      }
      return 0;
    })).toBe(0);
    await expect(lstat(state)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(directory, ".matrix-build-cache/.matrix-build.json"), "utf8")).version).toBe(1);
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });

  it("bounds empty output directories as well as emitted files", async () => {
    const directory = await fixture();
    const output = join(directory, "dist");
    for (let offset = 0; offset < 10000; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => mkdir(join(output, `empty-${offset + index}`))));
    }
    await expect(buildTypescript(directory, async () => 0)).rejects.toThrow("bounds");
    await expect(readFile(join(directory, ".matrix-build-cache/.matrix-build.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an output manifest larger than the reader's byte limit", async () => {
    const directory = await fixture();
    const prefix = "x".repeat(200);
    // Small file payloads can still produce an oversized path/hash manifest.
    for (let offset = 0; offset < 8200; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(directory, "dist", `${prefix}-${offset + index}`), "")));
    }
    await expect(buildTypescript(directory, async () => 0)).rejects.toThrow("manifest exceeds");
    expect(await readdir(join(directory, ".matrix-build-cache"))).toEqual([]);
  });
});
