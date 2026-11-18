import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it("loads the host's closure and generation-lock package subpaths from production dist with no source tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "terminal-runtime-exports-"));
  try {
    // Run the package's real build without sharing any pre-existing dist files.
    const packageSource = resolve("packages/terminal-runtime");
    const buildRoot = join(root, "build");
    const buildPackage = join(buildRoot, "packages/terminal-runtime");
    const dependencies = join(packageSource, "node_modules");
    const buildDependencies = join(buildPackage, "node_modules");
    await mkdir(buildDependencies, { recursive: true });
    await Promise.all([
      cp(resolve("tsconfig.json"), join(buildRoot, "tsconfig.json")),
      cp(join(packageSource, "package.json"), join(buildPackage, "package.json")),
      cp(join(packageSource, "tsconfig.json"), join(buildPackage, "tsconfig.json")),
      cp(join(packageSource, "src"), join(buildPackage, "src"), { recursive: true }),
    ]);
    for (const dependency of await readdir(dependencies)) {
      if (!dependency.startsWith(".")) {
        await symlink(join(dependencies, dependency), join(buildDependencies, dependency), "dir");
      }
    }
    // pnpm's executable shims resolve compiler paths relative to their real location.
    await exec("pnpm", ["run", "build"], {
      cwd: buildPackage,
      env: { ...process.env, PATH: [join(dependencies, ".bin"), process.env.PATH].filter(Boolean).join(delimiter) },
      timeout: 60_000,
    });

    const runtimeRoot = join(root, "runtime");
    const packageRoot = join(runtimeRoot, "node_modules/@matrix-os/terminal-runtime");
    await mkdir(packageRoot, { recursive: true });
    await cp(join(buildPackage, "package.json"), join(packageRoot, "package.json"));
    await cp(join(buildPackage, "dist"), join(packageRoot, "dist"), { recursive: true });
    await rm(buildRoot, { recursive: true });

    await writeFile(join(runtimeRoot, "probe.mjs"), `import {validateTerminalClosure} from '@matrix-os/terminal-runtime/generation-closure';
import {withTerminalGenerationLock} from '@matrix-os/terminal-runtime/generation-lock';
console.log(JSON.stringify([typeof validateTerminalClosure,typeof withTerminalGenerationLock]));`);
    const observed = await exec(process.execPath, [join(runtimeRoot, "probe.mjs")], {
      cwd: runtimeRoot,
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
      timeout: 10_000,
    });
    expect(JSON.parse(observed.stdout)).toEqual(["function", "function"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 75_000);
