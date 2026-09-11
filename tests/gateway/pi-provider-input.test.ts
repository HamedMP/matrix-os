import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { AgentThreadEvent, AgentThreadSummary } from "@matrix-os/contracts";
import { createPiCodingAgentProvider, type PiSpawnFn } from "../../packages/gateway/src/coding-agents/pi-provider";

const now = () => new Date("2026-09-11T00:00:00.000Z");
const principal = { userId: "owner_user", source: "jwt" as const };
const thread: AgentThreadSummary = { id: "thread_pi_input", providerId: "pi", title: "Question", status: "running", attention: "none", createdAt: now().toISOString(), updatedAt: now().toISOString() };
function fixture() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const lifecycle = new EventEmitter();
  const frames: Record<string, unknown>[] = [];
  const kill = vi.fn((signal: string) => queueMicrotask(() => lifecycle.emit("exit", null, signal)));
  const spawn = vi.fn<PiSpawnFn>(() => ({ stdout, stderr, once: lifecycle.once.bind(lifecycle), kill,
    stdin: { write: (line: string) => { frames.push(JSON.parse(line)); return true; } },
  }));
  const provider = createPiCodingAgentProvider({ homePath: "/tmp/pi-input", spawnFn: spawn, killGraceMs: 5 });
  const events: AgentThreadEvent[] = [];
  let id = 0;
  const nextEventId = () => `evt_pi_${++id}`;
  const pending = provider.startThread({ principal, thread, request: { providerId: "pi", prompt: "Ask where", sandboxMode: "read_only", clientRequestId: "req_pi_input" }, now, nextEventId, publishEvents: async batch => { events.push(...batch.events); } });
  return { provider, frames, spawn, kill, events, pending, nextEventId, emit: (event: unknown) => stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`)) };
}

it("starts RPC with a stdin prompt and answers a native select in the same process", async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled());
  expect(f.spawn.mock.calls[0]![1]).toContain("rpc");
  expect(f.spawn.mock.calls[0]![1]).not.toContain("--print");
  expect(f.frames).toContainEqual(expect.objectContaining({ type: "prompt", message: "Ask where" }));
  f.emit({ type: "extension_ui_request", id: "native_1", method: "select", title: "Where next?", options: ["North", "South"] });
  await vi.waitFor(() => expect(f.events.some(e => e.type === "user_input.requested")).toBe(true));
  const event = f.events.find(e => e.type === "user_input.requested")!;
  if (event.type !== "user_input.requested") throw new Error("Missing request");
  expect(() => f.provider.submitInput!({ principal, thread, inputRequestId: event.request.requestId, request: {
    clientRequestId: "req_wrong", correlationId: "corr_other", answer: "North",
  }, now, nextEventId: f.nextEventId })).toThrow("Input request unavailable");
  expect(() => f.provider.submitInput!({ principal, thread, inputRequestId: event.request.requestId, request: {
    clientRequestId: "req_invalid", correlationId: event.request.correlationId, answer: "East",
  }, now, nextEventId: f.nextEventId })).toThrow("Invalid input answer");
  await f.provider.submitInput!({ principal, thread, inputRequestId: event.request.requestId, request: { clientRequestId: "req_answer", correlationId: event.request.correlationId, answer: "North", structuredAnswers: { question: ["North"] } }, now, nextEventId: f.nextEventId });
  expect(f.frames).toContainEqual({ type: "extension_ui_response", id: "native_1", value: "North" });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  f.emit({ type: "agent_end", messages: [] });
  expect(f.kill).not.toHaveBeenCalled();
  f.emit({ type: "agent_settled" });
  const result = await f.pending;
  expect(result.events).toContainEqual(expect.objectContaining({ type: "thread.completed", outcome: "completed" }));
});

it("steers without restarting the process and aborts pending questions", async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled());
  await f.provider.steerTurn!({ principal, thread, message: "Keep going", clientRequestId: "req_steer" });
  expect(f.frames).toContainEqual(expect.objectContaining({ type: "steer", message: "Keep going" }));
  expect(f.kill).not.toHaveBeenCalled();
  await f.provider.abortThread({ principal, thread, now, nextEventId: f.nextEventId });
  await f.pending;
  expect(f.frames).toContainEqual({ type: "abort" });
});

it.each(["input", "editor", "confirm"])("answers native %s dialogs with the correct response frame", async method => {
  const f = fixture();
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled());
  f.emit({ type: "extension_ui_request", id: "native_text", method, title: "Continue?" });
  await vi.waitFor(() => expect(f.events.some(e => e.type === "user_input.requested")).toBe(true));
  const event = f.events.find(e => e.type === "user_input.requested")!;
  if (event.type !== "user_input.requested") throw new Error("Missing request");
  const value = method === "confirm" ? "No" : "Owner's answer";
  await f.provider.submitInput!({ principal, thread, inputRequestId: event.request.requestId, request: {
    clientRequestId: "req_reply", correlationId: event.request.correlationId, answer: value,
    structuredAnswers: { question: [value] },
  }, now, nextEventId: f.nextEventId });
  expect(f.frames).toContainEqual({ type: "extension_ui_response", id: "native_text", ...(method === "confirm" ? { confirmed: false } : { value }) });
  expect(() => f.provider.submitInput!({ principal, thread, inputRequestId: event.request.requestId, request: {
    clientRequestId: "req_stale", correlationId: event.request.correlationId, answer: value,
  }, now, nextEventId: f.nextEventId })).toThrow("Input request unavailable");
  f.emit({ type: "agent_settled" });
  await f.pending;
});

it("expires unanswered dialogs and ignores fire-and-forget extension notifications", async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled());
  f.emit({ type: "extension_ui_request", id: "notice", method: "notify", message: "Hello" });
  f.emit({ type: "extension_ui_request", id: "short", method: "input", title: "Answer quickly", timeout: 10 });
  await vi.waitFor(() => expect(f.frames).toContainEqual({ type: "extension_ui_response", id: "short", cancelled: true }));
  expect(f.events.filter(e => e.type === "user_input.requested")).toHaveLength(1);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "user_input.answered", reason: "expired" }));
  f.emit({ type: "agent_settled" });
  await f.pending;
});
