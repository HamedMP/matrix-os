import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";

// Lower only transport budgets, retaining the real parser/adapter/CLI lifecycle.
vi.mock("../../packages/gateway/src/chat/cli-process.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/chat/cli-process.js")>();
  return { ...actual, runCanonicalCli: (options: Parameters<typeof actual.runCanonicalCli>[0]) => actual.runCanonicalCli({ ...options, maxStdoutBytes: 64 }) };
});
vi.mock("../../packages/gateway/src/chat/bounded-cli-lines.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/chat/bounded-cli-lines.js")>();
  return { ...actual, createBoundedCliLines: (_max: number, consume: (line: string) => void) => actual.createBoundedCliLines(128, consume) };
});

async function start() {
  const stdout = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { stdout, stderr: new EventEmitter(),
    stdin: { write: (_frame: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; } },
    kill: vi.fn((signal: NodeJS.Signals) => queueMicrotask(() => child.emit("exit", null, signal))),
  });
  const adapter = createClaudeChatProviderAdapter({ homePath: "/safe/home", spawnFn: () => child,
    resolveCredentialLaunch: async () => ({ env: {} }) });
  const events: CanonicalProviderRunEvent[] = [];
  const done = (async () => { for await (const event of adapter.start({ owner: { type: "personal", ownerId: "owner_framed" },
    chatId: "chat_framed", turnId: "cturn_framed", runId: "run_framed", prompt: "Work", parts: [{ type: "text", text: "Work" }],
    selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" }, interactionMode: "default", permissionMode: "supervised",
    signal: new AbortController().signal })) events.push(event); })();
  await new Promise<void>(resolve => setImmediate(resolve));
  const send = (frame: unknown) => stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  return { child, stdout, events, done, send };
}

it("does not charge valid Claude protocol frames against a whole-run stdout cap", async () => {
  const run = await start();
  run.send({ type: "system", session_id: "s" });
  for (let index = 0; index < 30; index++) run.send({ type: "ping" });
  run.send({ type: "result", subtype: "success", result: "done" });
  run.child.emit("exit", 0, null);
  await run.done;
  expect(run.events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  expect(run.child.kill).not.toHaveBeenCalled();
});

it("still rejects an unfinished oversized Claude protocol frame", async () => {
  const run = await start();
  run.send({ type: "system", session_id: "s" });
  run.stdout.emit("data", Buffer.from("x".repeat(80)));
  run.stdout.emit("data", Buffer.from("x".repeat(49)));
  await run.done;
  expect(run.events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
  expect(run.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
});
