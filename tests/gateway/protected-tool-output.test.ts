import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, symlink, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToolOutputKey, tryLoadToolOutputKey, sealToolOutput, openToolOutput } from "../../packages/gateway/src/coding-agents/protected-tool-output.mjs";
import { codexToolOutput } from "../../packages/gateway/src/coding-agents/codex-tool-output.mjs";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
describe("protected tool result boundary", () => {
  it("never treats unmatched arbitrary text as public-safe", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c3ludGhldGlj";
    expect(JSON.stringify(codexToolOutput({ result: jwt }))).not.toContain(jwt);
  });
  it("encrypts opaque results and authenticates the tool identity", () => {
    const key = Buffer.alloc(32, 3);
    const text = "opaque credential without a recognizable marker";
    const sealed = sealToolOutput(key, "tool-1", text);
    expect(JSON.stringify(sealed)).not.toContain(text);
    expect(openToolOutput(key, "tool-1", sealed)).toBe(text);
    expect(() => openToolOutput(key, "tool-2", sealed)).toThrow();
    expect(() => openToolOutput(Buffer.alloc(32, 4), "tool-1", sealed)).toThrow();
    expect(() => openToolOutput(key, "tool-1", { ...sealed, tag: Buffer.alloc(16).toString("base64") })).toThrow();
  });
  it("uses one private key across restarts and concurrent initialization", async () => {
    const home = await mkdtemp(join(tmpdir(), "tool-output-")); homes.push(home);
    const keys = await Promise.all([loadToolOutputKey(home), loadToolOutputKey(home)]);
    expect(keys[0]).toEqual(keys[1]);
    expect(await readdir(join(home, "system"))).toEqual([".tool-output.key"]);
    expect(await loadToolOutputKey(home)).toEqual(keys[0]);
    expect((await stat(join(home, "system", ".tool-output.key"))).mode & 0o777).toBe(0o600);
  });
});

it("rejects symlink and permissive configuration keys", async () => {
  const home = await mkdtemp(join(tmpdir(), "tool-output-")); homes.push(home);
  await mkdir(join(home, "system"));
  const target = join(home, "other-key"); await writeFile(target, Buffer.alloc(32), { mode: 0o600 });
  const path = join(home, "system", ".tool-output.key");
  await symlink(target, path);
  await expect(loadToolOutputKey(home)).rejects.toThrow();
  await rm(path); await writeFile(path, Buffer.alloc(32), { mode: 0o644 });
  await expect(loadToolOutputKey(home)).rejects.toThrow("Invalid tool output key");
});

it("degrades invalid keys to summary-only without leaving temporary files", async () => {
  const home = await mkdtemp(join(tmpdir(), "tool-output-")); homes.push(home);
  await mkdir(join(home, "system"));
  await writeFile(join(home, "system", ".tool-output.key"), "invalid", { mode: 0o600 });
  expect(await tryLoadToolOutputKey(home)).toBeUndefined();
  expect(await readdir(join(home, "system"))).toEqual([".tool-output.key"]);
});
