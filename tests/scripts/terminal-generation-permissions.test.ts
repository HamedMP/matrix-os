import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { stageTerminalGeneration } from "../../scripts/build-terminal-generation.mjs";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function packagingFixture() {
  const root = await mkdtemp("/tmp/matrix-generation-permissions-");
  roots.push(root);
  const file = async (name: string, content: string, mode = 0o644) => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode });
    return path;
  };
  // Only the platform-specific native ABI probe is a fixture. The production
  // packager creates, validates, publishes and reuses the real filesystem tree.
  const runtime = { version: "24.18.0", modules: "137", napi: "10", platform: "linux", arch: "x64", libc: "glibc:2.39" };
  const nodePath = await file("inputs/node", `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(runtime)}'\n`, 0o755);
  const zellijPath = await file("inputs/zellij", "zellij fixture", 0o755);
  const writerPath = await file("inputs/writer.node", "native writer fixture");
  const nodePtyRoot = join(root, "node-pty");
  await file("node-pty/package.json", JSON.stringify({ name: "node-pty", version: "1.1.0" }));
  await file("node-pty/lib/index.js", "exports.spawn = () => {};\n");
  await file("node-pty/lib/unixTerminal.js", "exports.UnixTerminal = class {};\n");
  const ptyNativePath = await file("node-pty/build/Release/pty.node", "native PTY fixture");
  const nodeAddonApiRoot = join(root, "node-addon-api");
  await file("node-addon-api/package.json", JSON.stringify({ name: "node-addon-api", version: "7.1.1" }));
  const assetsDirectory = join(root, "assets");
  for (const name of ["terminal-host", "terminal-service", "terminal-io-attach", "terminal-protocol", "generation-closure"]) {
    await file(`assets/${name}.mjs`, "export {};\n");
  }
  return { outputRoot: join(root, "output"), nodePath, zellijPath, writerPath, nodePtyRoot, nodeAddonApiRoot, ptyNativePath, assetsDirectory };
}

it.each([false, true])("publishes a generation traversable by the runtime user after root extraction (reuse: %s)", async reuse => {
  const input = await packagingFixture();
  let result = await stageTerminalGeneration(input);
  const originalGeneration = result.generation;
  if (reuse) {
    // Reproduce a previously packaged generation that inherited mkdtemp's
    // owner-only mode while keeping all validated payload bytes intact.
    await chmod(result.directory, 0o700);
    result = await stageTerminalGeneration(input);
  }
  expect((await stat(result.directory)).mode & 0o777).toBe(0o755);
  expect(result.generation).toBe(originalGeneration);
  expect((await readdir(join(input.outputRoot, "generations"))).some(name => name.startsWith(".incoming-"))).toBe(false);
});
