import { afterEach, expect, it, vi } from "vitest";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter";
import { hermesStartupInput, hermesStartupProcesses } from "../helpers/hermes-startup-process";

afterEach(() => vi.useRealTimers());

function start(options: Parameters<typeof hermesStartupProcesses>[0] = {}, runOptions: {
  timeoutMs?: number; aborted?: boolean;
} = {}) {
  const fixture = hermesStartupProcesses(options);
  const controller = new AbortController();
  if (runOptions.aborted) controller.abort();
  const adapter = createHermesChatProviderAdapter({ homePath: "/safe/home", spawnFn: fixture.spawnFn,
    readyTimeoutMs: 10, requestTimeoutMs: 10, timeoutMs: runOptions.timeoutMs });
  const events: CanonicalProviderRunEvent[] = [];
  let settled = false;
  const done = (async () => {
    for await (const event of adapter.start({ ...hermesStartupInput, signal: controller.signal })) events.push(event);
  })().then(() => undefined, (error: unknown) => error).finally(() => { settled = true; });
  return { fixture, controller, events, done, get settled() { return settled; } };
}

function reconnects(events: CanonicalProviderRunEvent[]) {
  return events.filter((event) => event.type === "agent.activity"
    && event.label.startsWith("Reconnecting") && event.status === "running");
}

it("reconnects after confirmed pre-prompt timeout and submits one Hermes prompt", async () => {
  vi.useFakeTimers();
  const fixture = hermesStartupProcesses({ timeouts: 1 });
  const controller = new AbortController();
  const adapter = createHermesChatProviderAdapter({ homePath: "/safe/home",
    spawnFn: fixture.spawnFn, readyTimeoutMs: 10 });
  const events: CanonicalProviderRunEvent[] = [];
  const running = (async () => {
    for await (const event of adapter.start({ ...hermesStartupInput, signal: controller.signal })) events.push(event);
  })();
  try {
    await vi.advanceTimersByTimeAsync(11);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.activity", kind: "phase", label: "Reconnecting… 1/5", status: "running",
    }));
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
    expect(fixture.children[0]!.exited).toBe(true);
    expect(fixture.requests()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fixture.children).toHaveLength(2);
    expect(fixture.requests().filter((request) => request.method === "session.create")).toHaveLength(1);
    expect(fixture.requests().filter((request) => request.method === "prompt.submit")).toHaveLength(1);
    fixture.children[1]!.event("message.complete", { text: "Inspection complete.", status: "complete" });
    await running;
    expect(events.filter((event) => event.type === "run.completed"))
      .toEqual([{ type: "run.completed", outcome: "completed" }]);
  } finally {
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    await running;
  }
});

it("succeeds on the fifth Hermes retry without duplicate prompt admission", async () => {
  vi.useFakeTimers();
  const run = start({ timeouts: 5 });
  await vi.advanceTimersByTimeAsync(8_000);
  expect(reconnects(run.events).map((event) => "label" in event && event.label)).toEqual([
    "Reconnecting… 1/5", "Reconnecting… 2/5", "Reconnecting… 3/5", "Reconnecting… 4/5", "Reconnecting… 5/5",
  ]);
  expect(run.fixture.children).toHaveLength(6);
  expect(run.fixture.children.slice(0, 5).every((child) => child.exited)).toBe(true);
  expect(run.fixture.requests().filter((request) => request.method === "prompt.submit")).toHaveLength(1);
  expect(run.events.some((event) => event.type === "run.completed")).toBe(false);
  run.fixture.children[5]!.event("message.complete", { text: "Recovered once.", status: "complete" });
  await run.done;
  expect(run.events.filter((event) => event.type === "run.completed"))
    .toEqual([{ type: "run.completed", outcome: "completed" }]);
  expect(vi.getTimerCount()).toBe(0);
});

it("exhausts exactly five Hermes retries and publishes one safe terminal error", async () => {
  vi.useFakeTimers();
  const run = start({ timeouts: 6 });
  await vi.advanceTimersByTimeAsync(8_000);
  await run.done;
  expect(run.fixture.children).toHaveLength(6);
  expect(run.fixture.children.every((child) => child.exited)).toBe(true);
  expect(run.fixture.requests()).toEqual([]);
  expect(reconnects(run.events)).toHaveLength(5);
  expect(run.events.filter((event) => event.type === "run.completed"))
    .toEqual([expect.objectContaining({ outcome: "failed", error: expect.objectContaining({
      safeMessage: "The Hermes connection failed. Try again.",
    }) })]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["backoff", "ready", "already_aborted"] as const)("cancels Hermes startup during %s without another child", async (phase) => {
  vi.useFakeTimers();
  const run = start({ timeouts: 6 }, { aborted: phase === "already_aborted" });
  await vi.advanceTimersByTimeAsync(phase === "backoff" ? 11 : 0);
  run.controller.abort();
  await vi.advanceTimersByTimeAsync(8_000);
  await run.done;
  expect(run.fixture.children).toHaveLength(phase === "already_aborted" ? 0 : 1);
  expect(run.fixture.requests()).toEqual([]);
  expect(run.events.filter((event) => event.type === "run.completed"))
    .toEqual([{ type: "run.completed", outcome: "aborted" }]);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps unconfirmed startup cleanup pending and ignores late ready/output until actual exit", async () => {
  vi.useFakeTimers();
  const run = start({ timeouts: 6, confirmExit: false });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(run.fixture.children).toHaveLength(1);
  expect(run.fixture.children[0]!.process.kill).toHaveBeenCalledWith("SIGKILL");
  expect(run.settled).toBe(false);
  expect(reconnects(run.events)).toHaveLength(0);
  expect(run.events).toContainEqual(expect.objectContaining({ type: "agent.activity",
    label: "Stopping", summary: "The Run could not be stopped. Its status is being checked.", status: "running" }));
  run.fixture.children[0]!.event("gateway.ready");
  run.fixture.children[0]!.event("message.delta", { text: "Late unowned output" });
  run.controller.abort();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(run.settled).toBe(false);
  expect(run.fixture.requests()).toEqual([]);
  expect(run.fixture.children).toHaveLength(1);
  expect(run.events.some((event) => event.type === "assistant.delta" || event.type === "run.completed")).toBe(false);
  run.fixture.children[0]!.exit();
  expect(await run.done).toBeUndefined();
  expect(run.events.filter((event) => event.type === "run.completed"))
    .toEqual([{ type: "run.completed", outcome: "aborted" }]);
  expect(run.settled).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["error", "protocol", "exit"] as const)("does not retry permanent Hermes startup %s", async (startupFailure) => {
  vi.useFakeTimers();
  const run = start({ startupFailure });
  await vi.advanceTimersByTimeAsync(8_000);
  await run.done;
  expect(run.fixture.children).toHaveLength(1);
  expect(run.fixture.requests()).toEqual([]);
  expect(reconnects(run.events)).toHaveLength(0);
  expect(run.events.filter((event) => event.type === "run.completed"))
    .toEqual([expect.objectContaining({ outcome: "failed" })]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["session.create", "prompt.submit"])("never replays a Hermes %s request timeout", async (ignoreMethod) => {
  vi.useFakeTimers();
  const run = start({ ignoreMethod });
  await vi.advanceTimersByTimeAsync(8_000);
  await run.done;
  expect(run.fixture.children).toHaveLength(1);
  expect(run.fixture.requests().filter((request) => request.method === ignoreMethod)).toHaveLength(1);
  expect(reconnects(run.events)).toHaveLength(0);
  expect(run.events.filter((event) => event.type === "run.completed"))
    .toEqual([expect.objectContaining({ outcome: "failed" })]);
});

it("keeps the overall run deadline across Hermes startup retries", async () => {
  vi.useFakeTimers();
  const run = start({ timeouts: 6 }, { timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(8_000);
  await run.done;
  expect(run.fixture.children).toHaveLength(1);
  expect(run.fixture.requests()).toEqual([]);
  expect(run.events.filter((event) => event.type === "run.completed"))
    .toEqual([expect.objectContaining({ outcome: "failed", error: expect.objectContaining({
      safeMessage: "The Hermes Run timed out.",
    }) })]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["session.create", "prompt.submit"])("retains post-ready %s failure ownership until actual exit", async (ignoreMethod) => {
  vi.useFakeTimers();
  const run = start({ ignoreMethod, confirmExit: false });
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.fixture.children[0]!.process.kill).toHaveBeenCalledWith("SIGKILL");
    expect(run.fixture.children[0]!.exited).toBe(false);
    expect(run.settled).toBe(false);
    expect(run.events.some((event) => event.type === "run.completed")).toBe(false);
    run.fixture.children[0]!.event("message.delta", { text: "Late retired output" });
    run.fixture.children[0]!.exit();
    await run.done;
    expect(run.events.filter((event) => event.type === "run.completed"))
      .toEqual([expect.objectContaining({ outcome: "failed" })]);
    expect(run.events.some((event) => event.type === "assistant.delta")).toBe(false);
    expect(run.fixture.children).toHaveLength(1);
  } finally {
    run.fixture.children[0]?.exit();
    run.controller.abort();
    await run.done;
  }
  expect(vi.getTimerCount()).toBe(0);
});
