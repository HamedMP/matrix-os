import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentThreadSummary } from "@matrix-os/contracts";
import { createPiCodingAgentProvider } from "../../packages/gateway/src/coding-agents/pi-provider.js";
import { createOpenCodeCodingAgentProvider } from "../../packages/gateway/src/coding-agents/opencode-provider.js";

let homePath: string;
beforeEach(async () => { homePath = await mkdtemp(join(tmpdir(), "coding-owner-long-")); });
afterEach(async () => { vi.useRealTimers(); await rm(homePath, { recursive: true, force: true }); });

function fixture(kind: "pi" | "opencode", maxRunMs?: number, blockCredentials = false) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write: vi.fn(() => true) },
    kill: vi.fn((_signal: NodeJS.Signals) => { queueMicrotask(() => child.emit("exit", null)); }),
  });
  let sessionId = "ses_owner_long";
  const spawn = vi.fn((_command: string, args: string[]) => {
    if (kind === "pi") sessionId = args[args.indexOf("--session-id") + 1]!;
    return child;
  });
  const options = { homePath, spawnFn: spawn, resolveProjectPath: async () => "/work/repo",
    resolveCredentialLaunch: async () => blockCredentials ? new Promise<never>(() => undefined) : ({ env: {}, ...(maxRunMs ? { maxRunMs } : {}) }) };
  const provider = kind === "pi" ? createPiCodingAgentProvider(options) : createOpenCodeCodingAgentProvider(options);
  const controller = new AbortController();
  const thread: AgentThreadSummary = { id: "thread_owner_long", providerId: kind, title: "Owner run", status: "queued", attention: "none", projectId: "repo", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let sequence = 0;
  const result = Promise.resolve(provider.startThread({ principal: { userId: "owner", source: "jwt" }, thread,
    request: { providerId: kind, projectId: "repo", prompt: "Write a short answer", sandboxMode: "read_only", clientRequestId: "req_owner_long" },
    signal: controller.signal, now: () => new Date(), nextEventId: () => `evt_long_${++sequence}` }));
  function complete() {
    const lines = kind === "pi" ? [
      { type: "session", version: 3, id: sessionId, cwd: "/work/repo" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ] : [{ type: "text", sessionID: sessionId, part: { id: "part_long", type: "text", text: "Done", time: { end: 1 } } }];
    for (const line of lines) child.stdout.emit("data", Buffer.from(`${JSON.stringify(line)}\n`));
    child.stdout.emit("end"); child.emit("exit", 0);
  }
  return { child, spawn, controller, result, complete };
}

it.each(["pi", "opencode"] as const)("lets a silent busy owner %s turn finish beyond the old ten-minute deadline", async kind => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const run = fixture(kind);
  try {
    await vi.waitFor(() => expect(run.spawn).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(run.child.kill).not.toHaveBeenCalled();
    run.complete();
    expect((await run.result).events).toContainEqual(expect.objectContaining({ type: "thread.completed", outcome: "completed" }));
  } finally { run.controller.abort(); await run.result; }
});

it.each(["pi", "opencode"] as const)("still stops a long owner %s turn explicitly", async kind => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const run = fixture(kind);
  await vi.waitFor(() => expect(run.spawn).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  run.controller.abort();
  expect((await run.result).events).toContainEqual(expect.objectContaining({ type: "thread.completed", outcome: "aborted" }));
  expect(run.child.kill).toHaveBeenCalledWith("SIGTERM");
});

it.each(["pi", "opencode"] as const)("preserves an explicit funded launch deadline for %s", async kind => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const run = fixture(kind, 1_000);
  await vi.waitFor(() => expect(run.spawn).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await run.result).events).toContainEqual(expect.objectContaining({ type: "thread.completed", outcome: "failed" }));
  expect(run.child.kill).toHaveBeenCalledWith("SIGTERM");
});


it.each(["pi", "opencode"] as const)("bounds blocked %s credential preparation independently of the busy turn", async kind => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const run = fixture(kind, undefined, true);
  await vi.advanceTimersByTimeAsync(30_001);
  expect((await run.result).events).toContainEqual(expect.objectContaining({ type: "thread.completed", outcome: "failed" }));
  expect(run.spawn).not.toHaveBeenCalled();
});
