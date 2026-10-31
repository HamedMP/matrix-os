import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundleTerminalHostAssets } from "../../scripts/build-terminal-generation.mjs";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("bundles persistent host/service/attach/protocol code without mutable package imports", async () => {
  const root = await mkdtemp("/tmp/t7build-"); roots.push(root);
  const metadata = await bundleTerminalHostAssets(process.cwd(), root);
  for (const entry of ["terminal-host.mjs", "terminal-service.mjs", "terminal-io-attach.mjs", "terminal-protocol.mjs"]) expect((await readFile(join(root, entry))).length).toBeGreaterThan(100);
  expect(metadata.outputs.every(output => output.imports.every(value => value.external && value.path.startsWith("node:")))).toBe(true);
  expect(metadata.inputs).toContain("packages/gateway/src/coding-agents/managed-launch-wrapper.mjs");
  expect(metadata.inputs).toContain("packages/gateway/src/terminal/hosted-pty.ts");
  expect(metadata.inputs).toContain("packages/gateway/src/terminal/writer-broker.ts");
}, 15000);
