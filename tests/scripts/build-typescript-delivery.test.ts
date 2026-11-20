import { spawnSync } from "node:child_process";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const root = process.cwd();

// Materialize the local script COPY inputs available at the first package build.
// This deliberately executes the produced artifact instead of checking whether
// one expected filename happens to appear somewhere in the Dockerfile.
async function copyBuildScripts(recipe: string, stage: string) {
  const instructions = recipe.replace(/\\\r?\n/g, " ").split(/\r?\n/).map(line => line.trim());
  const firstBuild = instructions.findIndex(line => /^RUN\s+.*\bpnpm\b.*\bbuild\b/.test(line));
  expect(firstBuild, "Docker recipe must contain a package build").toBeGreaterThanOrEqual(0);
  for (const instruction of instructions.slice(0, firstBuild)) {
    if (!instruction.startsWith("COPY ")) continue;
    const args = instruction.slice(5).trim().split(/\s+/);
    if (!args.some(arg => arg === "scripts" || arg.startsWith("scripts/"))) continue;
    // The current recipes use local, whitespace-separated COPY operands. Fail
    // explicitly if that contract changes rather than silently dropping inputs.
    expect(args.some(arg => arg.startsWith("--") || /[\[\]"']/.test(arg)), instruction).toBe(false);
    const destination = args.pop()!;
    for (const source of args) {
      if (source !== "scripts" && !source.startsWith("scripts/")) continue;
      const input = resolve(root, source);
      const info = await lstat(input);
      const target = join(stage, destination,
        info.isDirectory() || (args.length === 1 && !destination.endsWith("/")) ? "" : basename(source));
      await mkdir(dirname(target), { recursive: true });
      if (info.isDirectory()) await cp(input, target, { recursive: true });
      else await copyFile(input, target);
    }
  }
}

it.each(["Dockerfile", "Dockerfile.ai-relay"])(
  "%s delivers an importable shared compiler before its package build",
  async filename => {
    const stage = await mkdtemp(join(tmpdir(), "matrix-compiler-delivery-"));
    try {
      await copyBuildScripts(await readFile(resolve(root, filename), "utf8"), stage);
      const artifact = pathToFileURL(join(stage, "scripts/build-typescript.mjs")).href;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        const compiler = await import(${JSON.stringify(artifact)});
        if (typeof compiler.buildTypescript !== "function") throw new Error("Compiler export missing");
        console.log("compiler-import-ok");
      `], { cwd: stage, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("compiler-import-ok\n");
    } finally { await rm(stage, { recursive: true, force: true }); }
  },
);
