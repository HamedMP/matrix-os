import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { verifyJevHermesRuntimePin } from "../../packages/gateway/src/chat/jev-hermes-runtime-pin.js";

const run = promisify(execFile);
const pin = "e06df9c2eae6901f4c88f464e0ae6e753c0428b8";
const fixtures: string[] = [];
const environment = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await run("/usr/bin/git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
    env: environment, signal, timeout: 5_000, maxBuffer: 4096,
  })).stdout;
}
async function fixture(): Promise<{ original: string; copied: string }> {
  const base = await mkdtemp("/tmp/eng306-source-integrity-"); fixtures.push(base);
  const original = join(base, "original"); await mkdir(original);
  await git(original, ["init"]);
  await writeFile(join(original, "tracked.py"), "print('verified')\n");
  await writeFile(join(original, ".gitignore"), "ignored/\n");
  await git(original, ["add", "."]);
  await git(original, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "isolated source fixture"]);
  const copied = join(base, "copied"); await cp(original, copied, { recursive: true, preserveTimestamps: true });
  return { original, copied };
}
// Only the pin response is substituted: a generated tiny repository cannot
// have the upstream commit hash. Every content/import-code check runs real Git.
const command = async (args: string[], signal: AbortSignal): Promise<string> => args.includes("rev-parse") ? pin + "\n"
  : (await run("/usr/bin/git", args, { env: environment, signal, timeout: 5_000, maxBuffer: 4096 })).stdout;
afterEach(async () => { for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("restricted Hermes verifies source bytes after copying an artifact", () => {
  it("accepts identical tracked bytes with copied index metadata", async () => {
    const { original, copied } = await fixture();
    expect(await readFile(join(copied, "tracked.py"))).toEqual(await readFile(join(original, "tracked.py")));
    await expect(verifyJevHermesRuntimePin(copied, AbortSignal.timeout(15_000), command)).resolves.toBeUndefined();
  });
  it.each([false, true])("rejects modified tracked bytes, staged=%s", async staged => {
    const { original } = await fixture();
    await writeFile(join(original, "tracked.py"), "print('untrusted')\n");
    if (staged) await git(original, ["add", "tracked.py"]);
    await expect(verifyJevHermesRuntimePin(original, AbortSignal.timeout(15_000), command)).rejects.toThrow();
  });
  it.each(["untracked", "ignored"])("still rejects %s importable source", async mode => {
    const { original } = await fixture();
    const target = mode === "ignored" ? join(original, "ignored") : original;
    if (mode === "ignored") await mkdir(target);
    await writeFile(join(target, "injected.py"), "raise RuntimeError('not trusted')\n");
    await expect(verifyJevHermesRuntimePin(original, AbortSignal.timeout(15_000), command)).rejects.toThrow("Restricted runtime setup required");
  });
});
