import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexKeySaver, createProviderKeyVerifier } from "../../packages/gateway/src/ai-providers/provider-workflow-key.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";

const fault = vi.hoisted(() => ({ cleanup: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => {
    if (fault.cleanup && String(args[0]).includes("/.matrix-key-")) throw Object.assign(new Error("synthetic cleanup denied"), { code: "EACCES" });
    return fs.rm(...args);
  } };
});
const roots: string[] = [];
afterEach(async () => { fault.cleanup = false; vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(command?: string) {
  const home = await mkdtemp(join(tmpdir(), "key-cleanup-")); roots.push(home);
  const prefix = join(home, "runtime"), directory = join(home, ".codex");
  await mkdir(directory, { mode: 0o700 }); await mkdir(join(prefix, "bin"), { recursive: true });
  await writeFile(join(directory, "auth.json"), "previous", { mode: 0o600 });
  await writeFile(join(prefix, "bin/codex"), command ?? '#!/bin/sh\nread -r key\nprintf \'{"OPENAI_API_KEY":"%s","tokens":null}\\n\' "$key" > "$CODEX_HOME/auth.json"\n', { mode: 0o700 });
  const guard = () => createNativeProviderProfileGuard({ homePath: home, registry: { get: vi.fn(), observeAgentLiveness: vi.fn() } });
  const verify = createProviderKeyVerifier({ providerId: "openai", profile: "codex", profileGuard: guard(), fetchFn: async () => new Response("{}"), save: createCodexKeySaver({ homePath: home, runtimePrefix: prefix }) });
  return { home, directory, guard, verify };
}
const input = (apiKey = "sk-synthetic-first") => ({ harnessInstanceId: "harness_codex", providerId: "openai" as const, apiKey });

it("preserves a completed Connect and releases admission despite cleanup failure, with bounded private residue", async () => {
  const { directory, guard, verify } = await fixture(); const commit = vi.fn(async () => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  fault.cleanup = true;
  await expect(verify.connect!(input(), commit)).resolves.toBeUndefined();
  expect(commit).toHaveBeenCalledOnce(); expect(warn).toHaveBeenCalled();
  expect(await readFile(join(directory, "auth.json"), "utf8")).toContain("sk-synthetic-first");
  await expect(guard().run("codex", { kind: "write" }, async () => "available")).resolves.toBe("available");
  for (let attempt = 0; attempt < 3; attempt++) await expect(verify.connect!(input("sk-synthetic-next"), commit)).rejects.toThrow("unavailable");
  expect(commit).toHaveBeenCalledOnce();
  const residue = (await readdir(directory)).filter(name => name.startsWith(".matrix-key-"));
  expect(residue).toHaveLength(1);
  expect((await lstat(join(directory, residue[0]!))).mode & 0o777).toBe(0o700);
  await expect(guard().run("codex", { kind: "write" }, async () => "available")).resolves.toBe("available");
  fault.cleanup = false;
  await expect(verify.connect!(input("sk-synthetic-next"), commit)).resolves.toBeUndefined();
  expect(commit).toHaveBeenCalledTimes(2);
  expect((await readdir(directory)).filter(name => name.startsWith(".matrix-key-"))).toEqual([]);
});

it("does not mask a proven prepublication failure with a cleanup error or retain its profile lease", async () => {
  const { directory, guard, verify } = await fixture("#!/bin/sh\ncat >/dev/null\nexit 1\n");
  const commit = vi.fn(); fault.cleanup = true;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(verify.connect!(input(), commit)).rejects.toThrow("unavailable");
  expect(commit).not.toHaveBeenCalled(); expect(await readFile(join(directory, "auth.json"), "utf8")).toBe("previous");
  await expect(guard().run("codex", { kind: "write" }, async () => "available")).resolves.toBe("available");
});

it("refuses a symlink in the bounded staging slot without modifying its target or publishing credentials", async () => {
  const { home, directory, guard, verify } = await fixture();
  const target = join(home, "owner-data"); await mkdir(target); await writeFile(join(target, "keep"), "unchanged");
  await symlink(target, join(directory, ".matrix-key-staging")); const commit = vi.fn();
  await expect(verify.connect!(input(), commit)).rejects.toThrow("unavailable");
  expect(commit).not.toHaveBeenCalled(); expect(await readFile(join(target, "keep"), "utf8")).toBe("unchanged");
  expect(await readFile(join(directory, "auth.json"), "utf8")).toBe("previous");
  await expect(guard().run("codex", { kind: "write" }, async () => "available")).resolves.toBe("available");
});
