import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { resolveManagedPiRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import type { ResolvedBotRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { ManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import type { CanonicalProviderRunEvent } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";

const LEASE_FAILURE = { type: "run.completed", outcome: "failed", error: {
  code: "run_failed", safeMessage: "Matrix AI could not finish this request. Check progress before trying again.", retryable: false, recoveryActions: [],
} };
const abortedEvent = { type: "run.completed", outcome: "aborted" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Node's native AbortSignal.timeout bypasses fake clocks. Keep its existing deadline observable.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

const sources = {
  funded: { selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, accessSourceId: "matrix_included", api: "anthropic-messages" },
  anthropicApi: { selection: { instanceId: "matrix_pi_anthropic_api", model: "claude-sonnet-5", options: [
    { id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: "12345678-1234-4123-8123-123456789abc" },
  ] }, accessSourceId: "owner_anthropic_key", api: "anthropic-messages" },
  chatgptPlan: { selection: { instanceId: "matrix_pi_chatgpt_plan", model: "gpt-account-model", options: [
    { id: "accountId", value: "account_1" }, { id: "grantRevision", value: "3" },
  ] }, accessSourceId: "matrix_chatgpt_plan", api: "openai-responses" },
};
type Source = keyof typeof sources;
const longRunningSources: ReadonlyArray<{ name: string; source: Source }> = [
  { name: "Matrix funded", source: "funded" },
  { name: "owner Anthropic API", source: "anthropicApi" },
  { name: "owner ChatGPT subscription", source: "chatgptPlan" },
];

function fixture(phase: "route" | "input" | "admission" | "tools" | "source" | "worker" = "worker", preAborted = false, source: Source = "funded") {
  const gate = deferred<void>();
  const worker = deferred<{ ok: true; reply: { runId: string; status: "completed"; toolActions: number } }>();
  const snapshot = makeAiProviderSnapshot();
  const owner = { type: "personal" as const, ownerId: "owner" };
  const selection: CanonicalChatModelSelection = sources[source].selection;
  const funded = resolveManagedPiRoute(snapshot, sources.funded.selection);
  const resolved: ResolvedBotRoute = source === "anthropicApi" ? {
    ...funded, accessSourceId: "owner_anthropic_key",
    anthropicApi: { connectionRevision: 3, credentialGeneration: "12345678-1234-4123-8123-123456789abc" },
  } : source === "chatgptPlan" ? {
    ...funded, accessSourceId: "matrix_chatgpt_plan", route: { ...funded.route, api: "openai-responses", modelId: selection.model },
    subscription: { peerId: "peer_1", accountId: "account_1", grantRevision: 3, computerId: "main" },
  } : funded;
  const binding: ManagedPiRuntimeBinding = { kind: "managed_chat", ownerId: owner.ownerId, chatId: "chat_cancel", runId: "run_cancel",
    runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64),
    ...resolved, capabilities: ["artifact.read"], requestClass: "interactive" };
  const phaseEntered = vi.fn();
  const wait = async (current: typeof phase) => { if (phase === current) { phaseEntered(); await gate.promise; } };
  const release = vi.fn<(runtimeHandle: string) => Promise<void>>(async () => undefined);
  const closeRun = vi.fn<(runId: string) => Promise<void>>(async () => undefined);
  const forgetRun = vi.fn();
  const cancelInference = vi.fn();
  let loseLease: () => void = () => { throw new Error("Renewal was not started"); };
  const renewalStop = vi.fn(async () => undefined);
  const startRenewal = vi.fn((_binding: ManagedPiRuntimeBinding, onFailure: (error: unknown) => void) => {
    loseLease = () => onFailure(new Error("PRIVATE LEASE FAILURE"));
    return { stop: renewalStop };
  });
  const transportAborted = vi.fn();
  const runBot = vi.fn(async (request: { command: { kind: string }; signal?: AbortSignal }) => {
    if (request.command.kind === "bot.cancel") return { ok: true };
    request.signal?.addEventListener("abort", transportAborted, { once: true });
    phaseEntered(); return worker.promise;
  });
  const admit = vi.fn(async (input: { ownerId: string; chatId: string; runId: string; resolved: ResolvedBotRoute }) => {
    expect(input).toEqual({ ownerId: owner.ownerId, chatId: binding.chatId, runId: binding.runId, resolved });
    await wait("admission"); return binding;
  });
  const resolvePlan = vi.fn(async () => resolved);
  const resolveAnthropic = vi.fn(async () => resolved);
  const getSnapshot = vi.fn(async () => { await wait("route"); return snapshot; });
  const lifetime = new AbortController();
  const input = new AbortController();
  if (preAborted) input.abort();
  const runtime = createManagedPiRuntime({ homePath: "/owned", expectedOwnerId: owner.ownerId,
    ...(phase === "input" ? { inputHistory: async () => { await wait("input"); return { references: [], assertCurrent: async () => undefined }; } } : {}),
    admission: { admit, release, renew: async () => undefined, startRenewal,
      workspace: async () => "/owned/chat", toolAuthority: async () => ({ permissionMode: "supervised" }) },
    ownerTools: { open: async () => wait("tools"), closeRun } as unknown as ManagedPiOwnerTools,
    assertSource: async () => wait("source"),
    providers: { getSnapshot }, chatgptPlan: { resolve: resolvePlan } as never, matrixAnthropic: { resolve: resolveAnthropic } as never,
    lifetime: lifetime.signal,
    host: { client: { runBot } } as unknown as ScopeRuntimeHost, forgetRun, cancelInference });
  const events: CanonicalProviderRunEvent[] = [];
  let terminal: CanonicalProviderRunEvent | undefined;
  const done = (async () => {
    for await (const event of runtime.adapter.start({ owner, chatId: binding.chatId, runId: binding.runId, turnId: "cturn_cancel", selection,
      prompt: "hello", parts: [{ type: "text", text: "hello" }], interactionMode: "default", permissionMode: "supervised", signal: input.signal })) {
      events.push(event); if (event.type === "run.completed") terminal = event;
    }
  })();
  return { runtime, input, lifetime, gate, worker, binding, release, startRenewal, renewalStop, loseLease: () => loseLease(), closeRun, forgetRun, cancelInference, phaseEntered, runBot, admit, done, events,
    getSnapshot, resolvePlan, resolveAnthropic, transportAborted,
    terminal: () => terminal,
    stop: () => runtime.adapter.cancel!({ owner, chatId: binding.chatId, runId: binding.runId }) };
}
async function ready(test: ReturnType<typeof fixture>) {
  await vi.advanceTimersByTimeAsync(0);
  expect(test.phaseEntered).toHaveBeenCalledOnce();
}

it.each(longRunningSources)("reports $name Stop immediately and bounds checkpoint transport even when release fails", async ({ source }) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const test = fixture("worker", false, source); await ready(test);
  test.release.mockRejectedValueOnce(new Error("Release unavailable"));
  await test.stop(); await vi.advanceTimersByTimeAsync(0); await test.done;
  expect(test.terminal()).toEqual(abortedEvent);
  expect(test.cancelInference).toHaveBeenCalledOnce();
  expect(test.transportAborted).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(test.transportAborted).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(test.transportAborted).toHaveBeenCalledOnce();
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
});

it.each(longRunningSources)("keeps a silent busy $name turn alive beyond thirty minutes and accepts its eventual result", async ({ source }) => {
  const test = fixture("worker", false, source); await ready(test);
  expect(test.binding).toMatchObject({ accessSourceId: sources[source].accessSourceId,
    route: { api: sources[source].api, modelId: sources[source].selection.model } });
  expect(test.admit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ resolved: expect.objectContaining({
    accessSourceId: sources[source].accessSourceId, route: expect.objectContaining({ api: sources[source].api, modelId: sources[source].selection.model }),
  }) }));
  expect(test.getSnapshot).toHaveBeenCalledTimes(source === "funded" ? 1 : 0);
  expect(test.resolvePlan).toHaveBeenCalledTimes(source === "chatgptPlan" ? 1 : 0);
  expect(test.resolveAnthropic).toHaveBeenCalledTimes(source === "anthropicApi" ? 1 : 0);
  if (source === "chatgptPlan") expect(test.resolvePlan).toHaveBeenCalledExactlyOnceWith(
    { ...sources.chatgptPlan.selection, instanceId: "matrix_chatgpt_plan" }, "owner", "interactive");
  if (source === "anthropicApi") expect(test.resolveAnthropic).toHaveBeenCalledExactlyOnceWith(
    sources.anthropicApi.selection, "owner", "interactive");
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  expect(test.terminal()).toBeUndefined();
  expect(test.cancelInference).not.toHaveBeenCalled();
  test.worker.resolve({ ok: true, reply: { runId: test.binding.runId, status: "completed", toolActions: 1 } });
  await vi.advanceTimersByTimeAsync(0); await test.done;
  expect(test.terminal()).toEqual({ type: "run.completed", outcome: "completed" });
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(longRunningSources)("keeps $name Stop aborted after thirty-one silent minutes despite a late completed reply", async ({ source }) => {
  const test = fixture("worker", false, source); await ready(test);
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  expect(test.terminal()).toBeUndefined();
  const stopping = test.stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(test.terminal()).toEqual(abortedEvent);
  test.worker.resolve({ ok: true, reply: { runId: test.binding.runId, status: "completed", toolActions: 1 } });
  await vi.advanceTimersByTimeAsync(0); await stopping; await test.done;
  expect(test.events.filter(event => event.type === "run.completed")).toEqual([abortedEvent]);
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels an unresponsive worker when the runtime lease cannot be renewed", async () => {
  const test = fixture(); await ready(test);
  test.loseLease();
  await vi.advanceTimersByTimeAsync(0); await test.done;
  expect(test.terminal()).toEqual(LEASE_FAILURE);
  expect(test.cancelInference).toHaveBeenCalledExactlyOnceWith(test.binding);
  expect(test.renewalStop).toHaveBeenCalledOnce();
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
  test.worker.resolve({ ok: true, reply: { runId: test.binding.runId, status: "completed", toolActions: 1 } });
  await vi.advanceTimersByTimeAsync(0);
  expect(test.terminal()).toEqual(LEASE_FAILURE);
});

it("bounds a stalled setup step to sixty seconds without dispatching a late worker", async () => {
  const test = fixture("route"); await ready(test);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(test.terminal()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(test.terminal()).toMatchObject({ type: "run.completed", outcome: "failed" });
  await test.done;
  test.gate.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(test.admit).not.toHaveBeenCalled();
  expect(test.runBot).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps lease loss as the first cause when Stop arrives before a late successful reply", async () => {
  const test = fixture(); await ready(test);
  test.loseLease();
  const stopping = test.stop();
  test.worker.resolve({ ok: true, reply: { runId: test.binding.runId, status: "completed", toolActions: 1 } });
  await vi.advanceTimersByTimeAsync(0); await stopping;
  expect(test.terminal()).toEqual(LEASE_FAILURE);
  await test.done;
  expect(test.events.filter(event => event.type === "run.completed")).toHaveLength(1);
});

it("keeps Stop as the first cause when lease loss and a successful reply arrive later", async () => {
  const test = fixture(); await ready(test);
  const stopping = test.stop();
  test.loseLease();
  test.worker.resolve({ ok: true, reply: { runId: test.binding.runId, status: "completed", toolActions: 1 } });
  await vi.advanceTimersByTimeAsync(0);
  expect(test.terminal()).toEqual(abortedEvent);
  await stopping; await test.done;
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
  expect(vi.getTimerCount()).toBe(0);
});

it("refuses late worker events after Stop before a worker result settles", async () => {
  const test = fixture(); await ready(test);
  const stopping = test.stop();
  await expect(test.runtime.events.publish(test.binding, { seq: 1, event: { type: "assistant_delta", text: "late reply" } }))
    .rejects.toEqual(new BotBrokerActionError("stale_generation"));
  test.worker.resolve({ ok: true, reply: { runId: test.binding.runId, status: "completed", toolActions: 1 } });
  await vi.advanceTimersByTimeAsync(0); await stopping; await test.done;
  expect(test.events).not.toContainEqual({ type: "assistant.delta", text: "late reply" });
  expect(test.terminal()).toEqual(abortedEvent);
});

it.each(["input", "lifetime", "close"] as const)("reports %s cancellation as aborted without a worker reply", async cause => {
  const test = fixture(); await ready(test);
  if (cause === "input") test.input.abort();
  else if (cause === "lifetime") test.lifetime.abort();
  const closing = cause === "close" ? test.runtime.close() : Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(test.terminal()).toEqual(abortedEvent);
  await test.done;
  expect(test.cancelInference).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10_000);
  await closing;
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
});

it.each(["route", "input", "admission", "tools", "source"] as const)("bounds a stalled %s setup step and cleans up late resources", async phase => {
  const test = fixture(phase); await ready(test);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(test.terminal()).toMatchObject({ type: "run.completed", outcome: "failed" });
  await test.done;
  test.gate.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(test.runBot.mock.calls.filter(([request]) => request.command.kind === "bot.run")).toHaveLength(0);
  if (["admission", "tools", "source"].includes(phase)) expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
  else { expect(test.admit).not.toHaveBeenCalled(); expect(test.release).not.toHaveBeenCalled(); }
  if (phase === "tools") expect(test.closeRun).toHaveBeenCalledTimes(2);
  expect(test.forgetRun).toHaveBeenCalledExactlyOnceWith(test.binding.runId);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not begin routing an input that was already cancelled", async () => {
  const test = fixture("route", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(test.terminal()).toEqual(abortedEvent);
  await test.done;
  expect(test.phaseEntered).not.toHaveBeenCalled();
  expect(test.admit).not.toHaveBeenCalled();
  expect(test.runBot).not.toHaveBeenCalled();
});

it("releases once when worker cancellation is refused", async () => {
  const test = fixture(); await ready(test);
  test.runBot.mockImplementationOnce(async () => ({ ok: false }));
  await test.stop(); await vi.advanceTimersByTimeAsync(0);
  expect(test.terminal()).toEqual(abortedEvent);
  await test.done;
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds shutdown when the worker never acknowledges cancellation", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const test = fixture(); await ready(test);
  const cancel = deferred<{ ok: true }>();
  test.runBot.mockImplementationOnce(() => cancel.promise);
  let closed = false;
  const closing = test.runtime.close().then(() => { closed = true; });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(test.terminal()).toEqual(abortedEvent);
  expect(closed).toBe(true);
  expect(warn).toHaveBeenCalledWith("[managed-pi] cleanup still pending");
  await closing; await test.done;
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
  cancel.resolve({ ok: true }); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops runtime renewal after normal completion", async () => {
  const test = fixture(); await ready(test);
  test.worker.resolve({ ok: true, reply: { runId: test.binding.runId, status: "completed", toolActions: 0 } });
  await vi.advanceTimersByTimeAsync(0); await test.done;
  expect(test.terminal()).toEqual({ type: "run.completed", outcome: "completed" });
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
  expect(test.renewalStop).toHaveBeenCalledOnce();
  expect(test.cancelInference).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds terminal settlement while an unconfirmed runtime release stays pending", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const test = fixture(); await ready(test);
  const released = deferred<void>();
  test.release.mockImplementationOnce(() => released.promise);
  test.input.abort(); await vi.advanceTimersByTimeAsync(0);
  expect(test.terminal()).toEqual(abortedEvent);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(test.terminal()).toEqual(abortedEvent);
  await test.done;
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(warn).toHaveBeenCalledWith("[managed-pi] grace release failed", "TimeoutError");
  released.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});


it.each(["route", "input", "admission"] as const)("keeps Stop aborted while %s is pending", async phase => {
  const test = fixture(phase); await ready(test);
  await test.stop(); await vi.advanceTimersByTimeAsync(0);
  expect(test.terminal()).toEqual(abortedEvent);
  await test.done;
  test.gate.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(test.runBot).not.toHaveBeenCalled();
  expect(test.release).toHaveBeenCalledTimes(phase === "admission" ? 1 : 0);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not let remote approval revocation prevent runtime stop or terminal settlement", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const test = fixture(); await ready(test);
  const closed = deferred<void>();
  test.closeRun.mockImplementation(() => closed.promise);
  test.input.abort(); await vi.advanceTimersByTimeAsync(0);
  expect(test.cancelInference).toHaveBeenCalledOnce();
  expect(test.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(test.release).toHaveBeenCalledExactlyOnceWith(test.binding.runtimeHandle);
  expect(test.terminal()).toEqual(abortedEvent);
  await test.done;
  expect(warn).toHaveBeenCalledWith("[managed-pi] cleanup still pending");
  closed.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("handles a synchronous worker transport exception without exposing its message", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const test = fixture("source"); await ready(test);
  test.runBot.mockImplementationOnce(() => { throw new Error("PRIVATE TRANSPORT"); });
  test.gate.resolve(); await vi.advanceTimersByTimeAsync(0); await test.done;
  expect(test.terminal()).toMatchObject({ outcome: "failed", error: { code: "run_failed" } });
  expect(JSON.stringify(test.events)).not.toContain("PRIVATE TRANSPORT");
  expect(warn).toHaveBeenCalledWith("[managed-pi] run failed", { stage: "worker_dispatch", error: "Error" });
  expect(vi.getTimerCount()).toBe(0);
});

it("handles late admission cleanup rejection after terminal settlement", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const test = fixture("admission"); await ready(test);
  await vi.advanceTimersByTimeAsync(60_000); await test.done;
  test.release.mockRejectedValueOnce(new Error("PRIVATE RELEASE"));
  test.gate.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(test.terminal()).toMatchObject({ type: "run.completed", outcome: "failed" });
  expect(warn).toHaveBeenCalledWith("[managed-pi] late resource cleanup failed", "Error");
  expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE RELEASE");
  expect(vi.getTimerCount()).toBe(0);
});

it("reports failed approval cleanup without losing the lease failure outcome", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const test = fixture(); await ready(test);
  test.closeRun.mockRejectedValue(new Error("PRIVATE CLOSE"));
  test.loseLease(); await vi.advanceTimersByTimeAsync(0); await test.done;
  expect(test.terminal()).toEqual(LEASE_FAILURE);
  expect(warn).toHaveBeenCalledWith("[managed-pi] cleanup failed", "Error");
  expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE CLOSE");
  expect(test.release).toHaveBeenCalledOnce();
});
