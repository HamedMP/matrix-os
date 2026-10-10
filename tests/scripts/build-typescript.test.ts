import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
});
