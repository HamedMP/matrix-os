import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export async function waitForStartupText(path: string, text: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await readFile(path, "utf8")).includes(text)) return; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected public startup event: ${text}`);
}

export async function startCodexStartupRunner(options: {
  homePath?: string; eventPath?: string; failures?: number; timeoutMs?: number;
  mode?: string; readyGate?: string; stubProcess?: boolean;
} = {}) {
  const dir = options.homePath ?? await mkdtemp("/tmp/matrix-startup-");
  const eventPath = options.eventPath ?? join(dir, "events.jsonl");
  const requestsPath = join(dir, "requests.jsonl");
  const config = Buffer.from(JSON.stringify({ prompt: "Reply once", approvalPolicy: "never",
    sandbox: "workspace-write", writableRoots: [dir] })).toString("base64");
  const runnerPath = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
  const fixturePath = join(process.cwd(), "tests/fixtures/codex-startup-process.mjs");
  const child = spawn(process.execPath, [
    ...(options.stubProcess ? ["--import", join(process.cwd(), "tests/fixtures/codex-startup-process-stub.mjs")] : []),
    runnerPath, eventPath, process.version.slice(1), process.execPath, fixturePath, config,
  ], {
    cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      MATRIX_CODEX_STARTUP_TIMEOUT_MS: String(options.timeoutMs ?? 1_000),
      TEST_CODEX_STARTUP_STATE: join(dir, "state"), TEST_CODEX_STARTUP_REQUESTS: requestsPath,
      TEST_CODEX_STARTUP_FAILURES: String(options.failures ?? 1),
      TEST_CODEX_STARTUP_MODE: options.mode ?? "timeout",
      ...(options.readyGate ? { TEST_CODEX_STARTUP_READY_GATE: options.readyGate } : {}),
    },
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  child.stdout?.resume(); child.stderr?.resume();
  return { child, closed, eventPath, requestsPath, dir,
    async events(): Promise<Array<Record<string, unknown>>> {
      return (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    },
    async requests(): Promise<Array<{ attempt: number; method?: string; event?: string }>> {
      return (await readFile(requestsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        await closed;
        clearTimeout(timer);
      }
      if (!options.homePath) await rm(dir, { recursive: true, force: true });
    },
  };
}
