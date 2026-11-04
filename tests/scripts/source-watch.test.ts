import { spawn } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { localServiceProcesses } from "../../scripts/dev-local.mjs";

it("reloads three successive atomic saves with the source runner's watcher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "matrix-source-watch-"));
  const entry = join(directory, "entry.ts");
  const value = join(directory, "value.ts");
  // Match the ESM packages used by the real source runner.
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(value, 'export const value: number = 0;');
  await writeFile(entry, 'import { value } from "./value.ts"; console.log("WATCH_VALUE=" + value); setInterval(() => {}, 1000);');
  const args = localServiceProcesses.find(service => service.name === "gateway")!.args.slice(0, -1);
  // Exercise the same executable and watcher options as the production runner.
  const child = spawn(process.execPath, [...args, entry], { cwd: resolve("."), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
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
    for (const service of localServiceProcesses.filter(service => service.name !== "shell")) {
      expect(service.args[0]).toMatch(/tsx\/dist\/cli\.mjs$/);
      expect(service.args[1]).toBe("watch");
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(accept => child.once("close", accept));
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid!, "SIGTERM");
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);
