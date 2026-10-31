import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTerminalClosureManifest, terminalClosureGeneration } from "../../packages/terminal-runtime/src/generation-closure.mjs";
export const terminalFixtureRuntime = { version: "24.18.0", modules: "137", napi: "10", platform: "linux", arch: "x64", libc: "glibc:2.35", nodePty: "1.1.0", nodeAddonApi: "7.1.1", writerNapi: 8, protocol: 1 } as const;
/** Nonexecutable artifact metadata fixture only. Never a native/package acceptance lane. */
export async function terminalClosureFixture() {
  const dir = await mkdtemp("/tmp/t7gen-");
  for (const name of ["node", "zellij", "matrix-terminal-user-keeper.mjs", "matrix-terminal-attach.mjs", "terminal-host.mjs", "terminal-service.mjs", "terminal-io-attach.mjs", "terminal-protocol.mjs", "generation-closure.mjs", "terminal-writer.node", "node_modules/node-pty/package.json", "node_modules/node-pty/lib/index.js", "node_modules/node-pty/lib/unixTerminal.js", "node_modules/node-pty/build/Release/pty.node", "node_modules/node-addon-api/package.json"]) {
    await mkdir(join(dir, name, ".."), { recursive: true }); await writeFile(join(dir, name), name, { mode: ["node", "zellij", "matrix-terminal-user-keeper.mjs", "matrix-terminal-attach.mjs"].includes(name) ? 0o755 : 0o644 });
  }
  const manifest = await createTerminalClosureManifest(dir, terminalFixtureRuntime), generation = terminalClosureGeneration(manifest);
  await writeFile(join(dir, "closure.json"), JSON.stringify(manifest) + "\n"); await writeFile(join(dir, "GENERATION"), generation + "\n");
  return { dir, manifest, generation };
}
