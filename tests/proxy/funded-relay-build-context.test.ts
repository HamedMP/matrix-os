import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it("can execute the observability build entry using scripts shipped in the Relay builder", async () => {
  const root = process.cwd();
  const fixture = await mkdtemp(join(tmpdir(), "matrix-relay-build-context-"));
  directories.push(fixture);
  const dockerfile = await readFile(join(root, "Dockerfile.ai-relay"), "utf8");
  const builder = dockerfile.split("FROM deps AS builder\n")[1]!.split("\nFROM ")[0]!;
  // Materialize the actual builder's script COPY instructions. Keeping helper
  // modules at their declared destinations also exercises relative imports.
  for (const line of builder.split("\n")) {
    const copy = /^COPY (scripts\/\S+) (scripts\/\S+)$/.exec(line);
    if (!copy) continue;
    const destination = join(fixture, copy[2]!);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, copy[1]!), destination);
  }
  const packageDirectory = join(fixture, "packages/observability");
  await mkdir(join(packageDirectory, "src"), { recursive: true });
  await mkdir(join(packageDirectory, "node_modules"));
  const manifest = JSON.parse(await readFile(join(root, "packages/observability/package.json"), "utf8"));
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify(manifest));
  await writeFile(join(packageDirectory, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    strict: true, target: "ES2022", rootDir: "src", outDir: "dist", types: [],
  }, include: ["src"] }));
  await writeFile(join(packageDirectory, "src/index.ts"), "export const value: number = 42;\n");
  const compiler = createRequire(import.meta.url).resolve("typescript/package.json");
  await symlink(dirname(compiler), join(packageDirectory, "node_modules/typescript"));
  // Execute the real package entry and real compiler, including the helper's
  // compiler-supervisor subprocess. No injected compiler or extra helper copy.
  const result = spawnSync(manifest.scripts.build, {
    cwd: packageDirectory, shell: true, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(join(packageDirectory, "dist/index.js"), "utf8")).toContain("value = 42");
}, 20_000);
