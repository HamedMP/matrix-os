import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startCodexStartupRunner, waitForStartupText } from "../helpers/codex-startup-runner";

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  await closed;
  clearTimeout(timer);
}

async function waitForText(path: string, text: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try { if ((await readFile(path, "utf8")).includes(text)) return; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected public startup event: ${text}`);
}

it("retries a timed-out preprompt Codex initialization after confirmed stop and submits the prompt once", async () => {
  const dir = await mkdtemp("/tmp/matrix-startup-");
  const eventPath = join(dir, "events.jsonl");
  const requestsPath = join(dir, "requests.jsonl");
  const config = Buffer.from(JSON.stringify({ prompt: "Reply once", approvalPolicy: "never",
    sandbox: "workspace-write", writableRoots: [dir] })).toString("base64");
  const runnerPath = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
  const fixturePath = join(process.cwd(), "tests/fixtures/codex-startup-process.mjs");
  const child = spawn(process.execPath, [runnerPath, eventPath, process.version.slice(1), process.execPath, fixturePath, config], {
    cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      MATRIX_CODEX_STARTUP_TIMEOUT_MS: "1000", TEST_CODEX_STARTUP_STATE: join(dir, "state"),
      TEST_CODEX_STARTUP_REQUESTS: requestsPath },
  });
  child.stdout?.resume(); child.stderr?.resume();
  try {
    await waitForText(eventPath, "Reconnecting… 1/5");
    await waitForText(eventPath, "Started exactly once.");
    const records = (await readFile(requestsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.method === "turn/start")).toEqual([{ attempt: 2, method: "turn/start" }]);
    expect(records.findIndex((record) => record.event === "stopped"))
      .toBeLessThan(records.findIndex((record) => record.attempt === 2));
    const events = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
  } finally {
    await stop(child);
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

it("requires a matching initialize response before handing off the process", async () => {
  const h = await startCodexStartupRunner({ mode: "wrong_id" });
  try {
    await waitForStartupText(h.eventPath, "turn.completed");
    await h.closed;
    expect((await h.requests()).filter((record) => record.method === "turn/start"))
      .toEqual([{ attempt: 2, method: "turn/start" }]);
  } finally { await h.close(); }
}, 10_000);

it("cancels a ready/abort handoff race before any thread or prompt admission", async () => {
  const h = await startCodexStartupRunner({ stubProcess: true, mode: "ready_abort" });
  try {
    await waitForStartupText(h.eventPath, "turn.aborted");
    await h.closed;
    expect(await h.events()).toEqual([{ type: "turn.aborted" }]);
    expect(await h.requests()).toEqual([{ attempt: 1, method: "initialize" }]);
  } finally { await h.close(); }
}, 10_000);

it.each([5, 6])("allows exactly five retries with %i timed-out initialization attempts", async (failures) => {
  const h = await startCodexStartupRunner({ failures });
  try {
    await waitForStartupText(h.eventPath, failures === 5 ? "turn.completed" : "turn.failed", 20_000);
    await h.closed;
    const records = await h.requests();
    expect(records.filter((record) => record.method === "initialize")).toHaveLength(6);
    expect(records.filter((record) => record.method === "turn/start")).toHaveLength(failures === 5 ? 1 : 0);
    const events = await h.events();
    expect(events.filter((event) => event.type === "matrix.codex.tool.started").map((event) => event.displayName))
      .toEqual(["Reconnecting… 1/5", "Reconnecting… 2/5", "Reconnecting… 3/5", "Reconnecting… 4/5", "Reconnecting… 5/5"]);
    expect(events.filter((event) => String(event.type).startsWith("turn.")))
      .toEqual([{ type: failures === 5 ? "turn.completed" : "turn.failed" }]);
  } finally { await h.close(); }
}, 25_000);

it.each(["rejected", "malformed", "no_result"])("does not retry %s initialization", async (mode) => {
  const h = await startCodexStartupRunner({ mode });
  try {
    await waitForStartupText(h.eventPath, "turn.failed");
    await h.closed;
    const events = await h.events();
    expect(events).toEqual([{ type: "turn.failed" }]);
    expect(await h.requests()).toEqual([{ attempt: 1, method: "initialize" }, { attempt: 1, event: "stopped" }]);
  } finally { await h.close(); }
}, 10_000);

it("fences late startup success and output while waiting for the timed-out child to close", async () => {
  const h = await startCodexStartupRunner({ mode: "late_ready" });
  try {
    await waitForStartupText(h.eventPath, "turn.completed");
    await h.closed;
    expect(JSON.stringify(await h.events())).not.toContain("Discard late startup output");
    expect((await h.requests()).filter((record) => record.method === "turn/start"))
      .toEqual([{ attempt: 2, method: "turn/start" }]);
  } finally { await h.close(); }
}, 10_000);

it("contains startup stdin errors as one safe non-retried failure", async () => {
  const h = await startCodexStartupRunner({ stubProcess: true, mode: "stdin_error" });
  try {
    await waitForStartupText(h.eventPath, "turn.failed");
    await h.closed;
    const events = await h.events();
    expect(events.filter((event) => String(event.type).startsWith("turn."))).toEqual([{ type: "turn.failed" }]);
    expect(JSON.stringify(events)).not.toMatch(/Reconnecting|EPIPE|private transport/);
    expect(await h.requests()).toEqual([{ attempt: 1, method: "initialize" }]);
  } finally { await h.close(); }
}, 10_000);

it("retains an unconfirmed startup child until actual close, then settles Stop once", async () => {
  const h = await startCodexStartupRunner({ stubProcess: true });
  try {
    await waitForStartupText(h.eventPath, "Waiting for startup cleanup", 8_000);
    expect(h.child.exitCode).toBeNull();
    expect((await h.events()).some((event) => String(event.type).startsWith("turn."))).toBe(false);
    expect(await h.requests()).toEqual([{ attempt: 1, method: "initialize" }]);
    h.child.kill("SIGTERM");
    await h.closed;
    expect((await h.events()).filter((event) => String(event.type).startsWith("turn.")))
      .toEqual([{ type: "turn.aborted" }]);
    expect(await h.requests()).toEqual([{ attempt: 1, method: "initialize" }]);
  } finally { await h.close(); }
}, 10_000);

it("retains Codex startup ownership when termination calls throw instead of confirming exit", async () => {
  const h = await startCodexStartupRunner({ stubProcess: true, mode: "kill_error" });
  try {
    await vi.waitFor(async () => expect((await h.events()).length).toBeGreaterThan(0), { timeout: 8_000 });
    expect((await h.events()).some((event) => String(event.type).startsWith("turn."))).toBe(false);
    expect(await h.events()).toContainEqual(expect.objectContaining({ displayName: "Waiting for startup cleanup" }));
    expect(await h.requests()).toEqual([{ attempt: 1, method: "initialize" }]);
    await h.closed;
    expect((await h.events()).filter((event) => String(event.type).startsWith("turn.")))
      .toEqual([{ type: "turn.failed" }]);
    expect(JSON.stringify(await h.events())).not.toMatch(/EPERM|private process/);
  } finally { await h.close(); }
}, 12_000);

it("cancels startup backoff without a second process or a failed-run flash", async () => {
  const h = await startCodexStartupRunner({ failures: 6 });
  try {
    await waitForStartupText(h.eventPath, "Reconnecting… 1/5");
    h.child.kill("SIGTERM");
    await h.closed;
    expect((await h.requests()).some((record) => record.attempt > 1 || record.method === "turn/start")).toBe(false);
    const terminal = (await h.events()).filter((event) => ["turn.failed", "turn.aborted", "turn.completed"].includes(String(event.type)));
    expect(terminal).toEqual([{ type: "turn.aborted" }]);
  } finally { await h.close(); }
}, 10_000);
