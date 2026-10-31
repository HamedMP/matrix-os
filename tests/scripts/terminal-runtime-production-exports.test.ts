import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it("loads the host's closure and generation-lock package subpaths from production dist with no source tree", async () => {
  const root = await mkdtemp("/tmp/t7exports-");
  try {
    const packageRoot = join(root, "node_modules/@matrix-os/terminal-runtime");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await cp("packages/terminal-runtime/package.json", join(packageRoot, "package.json"));
    await cp("packages/terminal-runtime/src/generation-closure.mjs", join(packageRoot, "dist/generation-closure.mjs"));
    const require = createRequire(resolve("packages/scope-runtime/package.json"));
    const { transform } = require("esbuild") as typeof import("esbuild");
    const result = await transform(await readFile("packages/terminal-runtime/src/generation-lock.ts", "utf8"), { loader: "ts", format: "esm", target: "node24" });
    await writeFile(join(packageRoot, "dist/generation-lock.js"), result.code);
    await writeFile(join(root, "probe.mjs"), `import {validateTerminalClosure} from '@matrix-os/terminal-runtime/generation-closure';
import {withTerminalGenerationLock} from '@matrix-os/terminal-runtime/generation-lock';
console.log(JSON.stringify([typeof validateTerminalClosure,typeof withTerminalGenerationLock]));`);
    const observed = await exec(process.execPath, [join(root, "probe.mjs")], { cwd: root, timeout: 10000 });
    expect(JSON.parse(observed.stdout)).toEqual(["function", "function"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
