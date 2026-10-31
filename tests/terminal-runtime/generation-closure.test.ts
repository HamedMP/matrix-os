import { terminalClosureFixture, terminalFixtureRuntime } from "../helpers/terminal-closure.js";
import { createHash } from "node:crypto";
import { chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminalClosureGeneration, validateTerminalClosure, legacyTerminalGeneration } from "../../packages/terminal-runtime/src/generation-closure.mjs";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const runtime = terminalFixtureRuntime;
async function fixture() { const result = await terminalClosureFixture(); roots.push(result.dir); return result; }

describe("complete immutable Terminal generation", () => {
  it("hashes Node, JS, native and protocol assets and validates exact compatibility", async () => {
    const f = await fixture(); expect(await validateTerminalClosure(f.dir, f.generation, runtime)).toEqual(f.manifest);
    for (const path of ["node", "node_modules/node-pty/lib/index.js", "node_modules/node-pty/build/Release/pty.node", "terminal-writer.node", "terminal-protocol.mjs"]) {
      const changed = structuredClone(f.manifest); changed.assets.find(asset => asset.path === path)!.sha256 = "f".repeat(64);
      expect(terminalClosureGeneration(changed)).not.toBe(f.generation);
    }
    await expect(validateTerminalClosure(f.dir, f.generation, { ...runtime, modules: "999" })).rejects.toThrow();
    await expect(validateTerminalClosure(f.dir, f.generation, { ...runtime, arch: "arm64" })).rejects.toThrow();
  });
  it.each(["tampered", "missing", "symlink file", "symlink directory", "undeclared", "writable"])("rejects %s closure instead of searching mutable app dependencies", async fault => {
    const f = await fixture(), target = join(f.dir, "node_modules/node-pty/lib/index.js");
    if (fault === "tampered") await writeFile(target, "mutable app require");
    if (fault === "missing") await rm(target);
    if (fault === "symlink file") { await rm(target); await symlink("/opt/matrix/app/node_modules/node-pty/lib/index.js", target); }
    if (fault === "symlink directory") { await rm(join(f.dir, "node_modules"), { recursive: true }); await symlink("/opt/matrix/app/node_modules", join(f.dir, "node_modules")); }
    if (fault === "undeclared") await writeFile(join(f.dir, "unhashed.mjs"), "export default true");
    if (fault === "writable") await chmod(target, 0o666);
    await expect(validateTerminalClosure(f.dir, f.generation)).rejects.toThrow();
  });
  it("preserves the exact old three-asset generation algorithm", async () => {
    const f = await fixture(), names = ["zellij", "matrix-terminal-user-keeper.mjs", "matrix-terminal-attach.mjs"];
    const hashes = await Promise.all(names.map(async name => createHash("sha256").update(await readFile(join(f.dir, name))).digest("hex")));
    const expected = "gen_" + createHash("sha256").update(hashes.join("\n") + "\n").digest("hex");
    expect(await legacyTerminalGeneration(f.dir)).toBe(expected);
  });
});
