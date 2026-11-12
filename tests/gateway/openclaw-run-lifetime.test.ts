import { afterEach, expect, it, vi } from "vitest";
import { createOpenClawChatProviderAdapter } from "../../packages/gateway/src/chat/openclaw-provider-adapter.js";
import type { OpenClawRpcClient, OpenClawRpcCallOptions } from "../../packages/gateway/src/agent-config/openclaw-rpc.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function fixture(hangWait = false, rejectSubscription = false) {
  vi.useFakeTimers();
  const controller = new AbortController();
  const calls: { method: string; params: unknown; options?: OpenClawRpcCallOptions }[] = [];
  let complete = false;
  const rpc: OpenClawRpcClient = {
    async call(method, params, _signal, options) {
      calls.push({ method, params, options });
      if (method === "agent") return { runId: "remote_run", status: "accepted", sessionKey: "session", acceptedAt: 1 };
      if (method === "chat.abort") return { aborted: true };
      if (method !== "agent.wait") throw new Error("Unexpected request");
      return new Promise(resolve => {
        if (!hangWait) setTimeout(() => resolve({ runId: "remote_run", status: complete ? "ok" : "timeout" }), 30_000);
      });
    },
    subscribe: () => {
      if (rejectSubscription) throw new Error("Listener capacity");
      return { dispose() {} };
    },
    async close() {},
  };
  const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
  const events: CanonicalProviderRunEvent[] = [];
  const done = (async () => {
    for await (const event of adapter.start({
      owner: { type: "personal", ownerId: "owner" }, chatId: "chat", turnId: "cturn", runId: "run_claw",
      prompt: "hello", parts: [{ type: "text", text: "hello" }], selection: { instanceId: "openclaw_default", model: "openai:gpt-5.4" },
      interactionMode: "default", permissionMode: "full_access", signal: controller.signal,
    })) events.push(event);
  })();
  return { controller, adapter, calls, events, done, finish: () => { complete = true; } };
}

it("waits repeatedly on one accepted OpenClaw run beyond the old two/five-minute cutoffs", async () => {
  const run = fixture();
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  expect(run.events.some(event => event.type === "run.completed")).toBe(false);
  expect(run.calls.filter(call => call.method === "agent")).toHaveLength(1);
  expect(run.calls[0]?.params).toMatchObject({ timeout: 0 });
  expect(run.calls.filter(call => call.method === "agent.wait").length).toBeGreaterThan(50);
  expect(run.calls.filter(call => call.method === "agent.wait").every(call =>
    call.options?.timeoutMs === 35_000 && (call.params as { timeoutMs: number }).timeoutMs === 30_000)).toBe(true);
  run.finish();
  await vi.advanceTimersByTimeAsync(30_000);
  await run.done;
  expect(run.events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
});

it("settles Stop immediately when an OpenClaw wait ignores cancellation", async () => {
  const run = fixture(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(run.calls.some(call => call.method === "agent.wait")).toBe(true);
  run.controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  await run.done;
  expect(run.events.at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
  expect(run.calls.filter(call => call.method === "agent")).toHaveLength(1);
  expect(run.calls.some(call => call.method === "chat.abort")).toBe(true);
});

it("aborts unconfirmed remote work when a bounded wait request times out", async () => {
  const run = fixture(true);
  await vi.advanceTimersByTimeAsync(35_000);
  await run.done;
  expect(run.events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
  expect(run.calls.filter(call => call.method === "agent")).toHaveLength(1);
  expect(run.calls.some(call => call.method === "chat.abort")).toBe(true);
});

it("cleans up admission when the OpenClaw subscription registry is full", async () => {
  const run = fixture(false, true);
  await run.done;
  expect(run.events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
  await run.adapter.cancel({ owner: { type: "personal", ownerId: "owner" }, chatId: "chat", runId: "run_claw" });
  expect(run.calls).toHaveLength(0);
});

it("reserves one event listener per active run rather than also charging every wait", async () => {
  const run = fixture();
  await vi.advanceTimersByTimeAsync(60_000);
  // The RPC registry counts subscription and per-call listeners together.
  // A persistent subscription already receives the initial and between-wait frames.
  expect(run.calls.filter(call => call.method === "agent" || call.method === "agent.wait")
    .every(call => call.options?.onEvent === undefined)).toBe(true);
  run.finish();
  await vi.advanceTimersByTimeAsync(30_000);
  await run.done;
  expect(run.events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
});
