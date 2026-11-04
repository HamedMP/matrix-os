import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { localServiceProcesses } from "../../scripts/dev-local.mjs";

it.each(["source runner", "Docker dev entrypoint"])(
  "reloads three successive atomic saves with the %s watcher",
  async launcher => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-source-watch-"));
    try {
      const source = join(directory, "packages/gateway/src");
      const entry = join(source, "main.ts");
      const value = join(source, "value.ts");
      await mkdir(source, { recursive: true });
      // Match the ESM packages used by both real development launchers.
      await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(value, "export const value: number = 0;");
      await writeFile(entry, 'import { value } from "./value.ts"; console.log("WATCH_VALUE=" + value + ";PID=" + process.pid + ";PARENT=" + process.ppid); setInterval(() => {}, 1000);');
      let command = process.execPath;
      let cwd = resolve(".");
      let args = [...localServiceProcesses.find(service => service.name === "gateway")!.args.slice(0, -1), entry];
      if (launcher === "Docker dev entrypoint") {
        const distro = join(directory, "distro");
        await mkdir(distro);
        const entrypoint = join(distro, "docker-dev-entrypoint.sh");
        await copyFile(resolve("distro/docker-dev-entrypoint.sh"), entrypoint);
        await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
        // Keep the real default compiler watcher active with a valid, isolated
        // Kernel project; this test targets Gateway source reloads, not env.
        await mkdir(join(directory, "scripts/local-production-parity"), { recursive: true });
        for (const relative of ["scripts/dev-local.mjs", "scripts/dev-gateway.mjs", "scripts/source-processes.mjs", "scripts/build-typescript.mjs", "scripts/typescript-build-output.mjs", "scripts/local-production-parity/commands.mjs"]) {
          await copyFile(resolve(relative), join(directory, relative));
        }
        const kernel = join(directory, "packages/kernel");
        await mkdir(join(kernel, "src"), { recursive: true });
        await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", types: [], skipLibCheck: true } }));
        await writeFile(join(kernel, "tsconfig.json"), JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { rootDir: "src", outDir: "dist" }, include: ["src"] }));
        await writeFile(join(kernel, "package.json"), JSON.stringify({ type: "module" }));
        await writeFile(join(kernel, "src/index.ts"), "export const kernel = true;");
        command = "bash";
        args = [entrypoint, "--launch-gateway"];
        cwd = directory;
      }
      // The Docker switch execs its actual launcher before any bootstrap work.
      const child = spawn(command, args, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      const closed = new Promise(accept => child.once("close", accept));
      let output = "";
      child.stdout!.on("data", chunk => { output = (output + chunk).slice(-16000); });
      child.stderr!.on("data", chunk => { output = (output + chunk).slice(-16000); });
      const wait = async (revision: number) => {
        const deadline = performance.now() + 8000;
        while (!output.includes(`WATCH_VALUE=${revision}`)) {
          if (performance.now() >= deadline) throw new Error(`Atomic save ${revision} was not reloaded: ${output}`);
          await new Promise(accept => setTimeout(accept, 25));
        }
      };
      try {
        await wait(0);
        for (let revision = 1; revision <= 3; revision++) {
          await writeFile(`${value}.tmp`, `export const value: number = ${revision};`);
          await rename(`${value}.tmp`, value);
          await wait(revision);
        }
        if (launcher === "source runner") {
          for (const service of localServiceProcesses.filter(service => service.name !== "shell")) {
            expect(service.args[0]).toMatch(/tsx\/dist\/cli\.mjs$/);
            expect(service.args[1]).toBe("watch");
          }
        } else {
          // Killing the owned watcher unexpectedly must fail the foreground
          // launcher and reap the Gateway child that outlives its watcher.
          const runtime = Array.from(output.matchAll(/WATCH_VALUE=\d+;PID=(\d+);PARENT=(\d+)/g)).at(-1)!;
          process.kill(Number(runtime[2]), "SIGKILL");
          const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
          try { await closed; } finally { clearTimeout(timeout); }
          expect(child.exitCode, output).toBe(1);
          expect(output).toMatch(/gateway .*exited with SIGKILL/);
          expect(() => process.kill(Number(runtime[1]), 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const stop = (signal: NodeJS.Signals) => {
            try {
              if (process.platform === "win32") child.kill(signal);
              else process.kill(-child.pid!, signal);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          };
          stop("SIGTERM");
          const escalation = setTimeout(() => stop("SIGKILL"), 8000);
          try { await closed; } finally { clearTimeout(escalation); }
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  40000,
);
