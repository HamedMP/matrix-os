import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const root = process.cwd();
const pause = (ms: number) => new Promise(accept => setTimeout(accept, ms));
async function atomicWrite(path: string, contents: string) {
  await writeFile(`${path}.tmp`, contents);
  await rename(`${path}.tmp`, path);
}

it.each(["source runner", "Docker dev entrypoint"])("builds Kernel edits and reloads its dist consumer through the %s lifecycle", async launcher => {
  const directory = await mkdtemp(join(tmpdir(), "matrix-kernel-source-"));
  let runner: ChildProcess | undefined;
  let closed: Promise<unknown> | undefined;
  let output = "";
  let failure: Error | undefined;
  let activeCompilerPid: number | undefined;
  const kernel = join(directory, "packages/kernel");
  const index = join(kernel, "src/index.ts");
  const value = join(kernel, "src/value.ts");
  const config = { compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
    lib: ["ES2022"], types: [], strict: true, skipLibCheck: true, sourceMap: true,
  } };
  const packageConfig = { extends: "../../tsconfig.json", compilerOptions: { rootDir: "src", outDir: "dist" }, include: ["src"] };
  const indexSource = (revision: number) => `export const first = ({ value: ${revision} } as { value?: number })?.value ?? 0; export { second } from "./value.js";\n`;
  const snapshots = () => Array.from(output.matchAll(/KERNEL_VALUE=(\d+:\d+);PID=(\d+)/g), match => ({ pair: match[1], pid: Number(match[2]) }));
  const current = () => snapshots().at(-1);
  const waitFor = async (condition: () => boolean | Promise<boolean>, message: string) => {
    const deadline = performance.now() + 8000;
    while (!await condition()) {
      if (failure) throw failure;
      if (runner && (runner.exitCode !== null || runner.signalCode !== null)) throw new Error(`Source runner exited before ${message}: ${output}`);
      if (performance.now() >= deadline) throw new Error(`${message}: ${output}`);
      await pause(25);
    }
  };
  const sources = async (revision: number) => {
    await atomicWrite(index, indexSource(revision));
    await atomicWrite(value, `export const second = ${revision};\n`);
  };
  const outputs = () => Promise.all(["index.js", "index.js.map", "value.js", "value.js.map"]
    .map(file => readFile(join(kernel, "dist", file), "utf8")));
  try {
    for (const relative of ["distro", "scripts/local-production-parity", "packages/kernel/src", "packages/gateway/src", "packages/proxy/src", "packages/platform/src", "shell/node_modules/next/dist/bin"]) {
      await mkdir(join(directory, relative), { recursive: true });
    }
    await symlink(resolve(root, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify(config));
    await writeFile(join(kernel, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(kernel, "tsconfig.json"), JSON.stringify(packageConfig));
    for (const relative of ["distro/docker-dev-entrypoint.sh", "scripts/dev-local.mjs", "scripts/dev-gateway.mjs", "scripts/source-processes.mjs", "scripts/build-typescript.mjs", "scripts/typescript-build-output.mjs", "scripts/local-production-parity/commands.mjs"]) {
      await copyFile(resolve(root, relative), join(directory, relative));
    }
    await sources(0);
    const initial = spawnSync(process.execPath, [join(directory, "scripts/build-typescript.mjs")], {
      cwd: kernel, encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024,
    });
    expect(initial.error).toBeUndefined();
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    await writeFile(join(directory, "packages/gateway/src/main.ts"), `
      import { first, second } from "../../kernel/dist/index.js";
      console.log("KERNEL_VALUE=" + first + ":" + second + ";PID=" + process.pid);
      setInterval(() => {}, 1000);
    `);
    // Keep unrelated services inert. The real source supervisor, compiler and
    // Gateway watcher/compiled-module boundary are exercised; infra/env/auth
    // bootstrap and application HTTP behavior are not qualified by this test.
    for (const relative of ["packages/proxy/src/main.ts", "packages/platform/src/main.ts", "shell/node_modules/next/dist/bin/next"]) {
      await writeFile(join(directory, relative), 'console.log("AUX_PID=" + process.pid); setInterval(() => {}, 1000);');
    }
    await writeFile(join(directory, "run.mjs"), `
      import { startLocalDevelopment } from "./scripts/dev-local.mjs";
      await startLocalDevelopment({ startInfrastructure: async () => {}, runCommand: async () => {},
        waitForHttp: async () => {}, log: () => {} });
    `);
    const command = launcher === "source runner" ? process.execPath : "bash";
    const args = launcher === "source runner" ? [join(directory, "run.mjs")] : [join(directory, "distro/docker-dev-entrypoint.sh"), "--launch-gateway"];
    runner = spawn(command, args, {
      cwd: directory, env: { ...process.env, MATRIX_HOME: join(directory, "owner-home") },
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    closed = new Promise(accept => runner!.once("close", accept));
    runner.once("error", error => { failure = error; });
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-128 * 1024); };
    runner.stdout!.on("data", append);
    runner.stderr!.on("data", append);
    await waitFor(() => current()?.pair === "0:0", "Initial compiled Kernel did not load");
    for (let revision = 1; revision <= 3; revision++) {
      await sources(revision);
      await waitFor(() => current()?.pair === `${revision}:${revision}`, `Kernel edit ${revision} remained stale`);
    }
    // A root config change changes emitted syntax while retaining semantics.
    let previous = current()!;
    let emitted = await readFile(join(kernel, "dist/index.js"), "utf8");
    await atomicWrite(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { ...config.compilerOptions, target: "ES2019" } }));
    await waitFor(async () => current()?.pair === "3:3" && current()?.pid !== previous.pid
      && await readFile(join(kernel, "dist/index.js"), "utf8") !== emitted, "Root tsconfig change was not built");
    previous = current()!;
    emitted = await readFile(join(kernel, "dist/index.js"), "utf8");
    await atomicWrite(join(kernel, "tsconfig.json"), JSON.stringify({ ...packageConfig, compilerOptions: { ...packageConfig.compilerOptions, target: "ES2022" } }));
    await waitFor(async () => current()?.pair === "3:3" && current()?.pid !== previous.pid
      && await readFile(join(kernel, "dist/index.js"), "utf8") !== emitted, "Package tsconfig change was not built");
    previous = current()!;
    const lastGood = await outputs();
    const diagnosticStart = output.length;
    await atomicWrite(index, 'export const first = ; export { second } from "./value.js";\n');
    await waitFor(() => /error TS\d+/.test(output.slice(diagnosticStart)), "Compiler failure was not reported");
    await pause(350);
    expect(current()).toEqual(previous);
    expect(() => process.kill(previous.pid, 0)).not.toThrow();
    expect(await outputs()).toEqual(lastGood);
    await sources(4);
    await waitFor(() => current()?.pair === "4:4", "Corrected Kernel did not recover");
    expect(current()!.pid).not.toBe(previous.pid);
    await sources(5);
    await sources(6);
    await waitFor(() => current()?.pair === "6:6", "Burst edits did not converge to the newest source");
    // Stop the launcher while its real canonical compiler owns a live process
    // group. Its IPC supervisor must finish cancellation before cache release.
    await sources(7);
    await waitFor(async () => {
      try {
        activeCompilerPid = Number(await readFile(join(kernel, ".matrix-build-cache/.matrix-build.lock/compiler"), "utf8"));
        process.kill(activeCompilerPid, 0);
        return true;
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        return false;
      }
    }, "Compiler did not acquire ownership before shutdown");
  } finally {
    if (runner?.pid && runner.exitCode === null && runner.signalCode === null) {
      const stop = (signal: NodeJS.Signals) => {
        try {
          if (process.platform === "win32") runner!.kill(signal);
          else process.kill(-runner!.pid!, signal);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      };
      stop("SIGTERM");
      const escalation = setTimeout(() => stop("SIGKILL"), 8000);
      try { await closed; } finally { clearTimeout(escalation); }
    }
    try {
      if (activeCompilerPid) {
        expect(runner!.exitCode, output).toBe(0);
        const ownedPid = process.platform === "win32" ? activeCompilerPid : -activeCompilerPid;
        expect(() => process.kill(ownedPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        await expect(readFile(join(kernel, ".matrix-build-cache/.matrix-build.lock/compiler"))).rejects.toHaveProperty("code", "ENOENT");
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const pids = [...snapshots().map(snapshot => snapshot.pid), ...Array.from(output.matchAll(/AUX_PID=(\d+)/g), match => Number(match[1]))];
  expect(pids.length).toBeGreaterThanOrEqual(launcher === "source runner" ? 4 : 1);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}, 90_000);
