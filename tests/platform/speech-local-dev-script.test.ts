import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const launcher = resolve("scripts/dev-speech-stack.sh");
const temporaryDirectories: string[] = [];

type Invocation = {
  args: string[];
  pid: number;
  descendantPid?: number;
  providerKey: string;
  speechSecret: string;
};

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Timed out waiting for speech launcher subprocess state");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function invocations(logPath: string): Promise<Invocation[]> {
  try {
    return (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Invocation);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function setupFakePnpm(options: { failRole?: string; failCode?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "matrix-speech-launcher-test-"));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, "bin");
  await mkdir(binDirectory);
  const logPath = join(directory, "invocations.jsonl");
  const dotenvPath = join(directory, ".env");
  const providerKey = `provider-${randomBytes(24).toString("hex")}`;
  const speechSecret = `speech-${randomBytes(24).toString("hex")}`;
  await writeFile(dotenvPath, [
    `PLATFORM_SPEECH_OPENAI_API_KEY=${providerKey}`,
    `PLATFORM_SPEECH_SECRET=${speechSecret}`,
    "",
  ].join("\n"));
  const fakePnpm = join(binDirectory, "pnpm");
  await writeFile(fakePnpm, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
try { process.loadEnvFile(process.env.FAKE_DOTENV_PATH); } catch {}
const args = process.argv.slice(2);
const filterAt = args.indexOf("--filter");
const role = filterAt >= 0 ? args[filterAt + 1] : "unknown";
if (args.at(-1) === "build") {
  appendFileSync(process.env.FAKE_INVOCATION_LOG, JSON.stringify({
    args, pid: process.pid,
    providerKey: process.env.PLATFORM_SPEECH_OPENAI_API_KEY ?? "<unset>",
    speechSecret: process.env.PLATFORM_SPEECH_SECRET ?? "<unset>",
  }) + "\\n");
  process.exit(0);
}
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
appendFileSync(process.env.FAKE_INVOCATION_LOG, JSON.stringify({
  args, pid: process.pid, descendantPid: descendant.pid,
  providerKey: process.env.PLATFORM_SPEECH_OPENAI_API_KEY ?? "<unset>",
  speechSecret: process.env.PLATFORM_SPEECH_SECRET ?? "<unset>",
}) + "\\n");
if (role === process.env.FAKE_FAIL_ROLE) {
  setTimeout(() => process.exit(Number(process.env.FAKE_FAIL_CODE)), 150);
} else {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
`);
  await chmod(fakePnpm, 0o755);
  const child = spawn("bash", [launcher], {
    env: {
      ...process.env,
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_OPENAI_API_KEY: providerKey,
      PLATFORM_SPEECH_SECRET: speechSecret,
      FAKE_DOTENV_PATH: dotenvPath,
      FAKE_INVOCATION_LOG: logPath,
      FAKE_FAIL_ROLE: options.failRole ?? "",
      FAKE_FAIL_CODE: String(options.failCode ?? 1),
      MATRIX_SPEECH_STACK_TERMINATION_GRACE_MS: "100",
    },
    stdio: "ignore",
  });
  return { child, logPath, providerKey, speechSecret };
}

function completion(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveCompletion({ code, signal }));
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("local speech stack launcher", () => {
  it("isolates secrets and tears down all process groups after an early service failure", async () => {
    const run = await setupFakePnpm({ failRole: "@matrix-os/gateway", failCode: 23 });
    const result = await completion(run.child);
    expect(result).toEqual({ code: 23, signal: null });

    const calls = await invocations(run.logPath);
    expect(calls[0]?.args).toEqual([
      "--filter", "@matrix-os/observability",
      "--filter", "@matrix-os/brand",
      "--filter", "@matrix-os/kernel",
      "build",
    ]);
    const byFilter = new Map(calls.slice(1).map((call) => [call.args[1], call]));
    expect([...byFilter.keys()].sort()).toEqual(["./shell", "@matrix-os/gateway", "@matrix-os/platform"]);
    expect(calls[0]).toMatchObject({ providerKey: "", speechSecret: "" });
    expect(byFilter.get("@matrix-os/platform")).toMatchObject({
      providerKey: run.providerKey,
      speechSecret: run.speechSecret,
    });
    expect(byFilter.get("@matrix-os/gateway")).toMatchObject({ providerKey: "", speechSecret: "" });
    expect(byFilter.get("./shell")).toMatchObject({ providerKey: "", speechSecret: "" });

    const taskPids = calls.flatMap((call) => [call.pid, call.descendantPid].filter((pid): pid is number => Boolean(pid)));
    await waitFor(async () => taskPids.every((pid) => !isAlive(pid)));
  }, 10_000);

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("returns the conventional %s code and leaves no task-owned descendants", async (signal, exitCode) => {
    const run = await setupFakePnpm();
    await waitFor(async () => (await invocations(run.logPath)).length === 4);
    const completed = completion(run.child);
    run.child.kill(signal);
    await expect(completed).resolves.toEqual({ code: exitCode, signal: null });
    const calls = await invocations(run.logPath);
    const taskPids = calls.flatMap((call) => [call.pid, call.descendantPid].filter((pid): pid is number => Boolean(pid)));
    await waitFor(async () => taskPids.every((pid) => !isAlive(pid)));
  }, 10_000);
});
