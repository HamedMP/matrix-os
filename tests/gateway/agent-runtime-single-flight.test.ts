import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentRuntimeServices } from "../../packages/gateway/src/agent-config/runtime-services.js";
import { AgentConfigError } from "../../packages/gateway/src/agent-config/errors.js";
import { createRuntimeObservation } from "../../packages/gateway/src/agent-config/runtime-observation.js";
import type { AgentRuntimeSettingsSnapshot } from "../../packages/gateway/src/agent-config/service.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "runtime-single-flight-"));
  homes.push(homePath);
  await mkdir(join(homePath, "system"));
  await writeFile(join(homePath, "system/config.json"), JSON.stringify({ agent: { messagingRuntime: "openclaw", revision: 0 } }));
  let pending = 0, refused = 0, peak = 0;
  const primary = "anthropic/claude-haiku-4-5";
  const responses: Record<string, unknown> = { health: { ok: true }, "models.list": { models: [{ id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic", available: true }] }, "models.authStatus": { ts: 1, providers: [{ provider: "anthropic", status: "static", profiles: [{ profileId: "test", type: "api_key", status: "static" }] }] } };
  const call = vi.fn(async (method: string, _params: unknown, signal: AbortSignal) => {
    if (pending >= 8) {
      refused++;
      throw new AgentConfigError("agent_config_conflict");
    }
    pending++;
    peak = Math.max(peak, pending);
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      signal.throwIfAborted();
      return method === "config.get" ? { valid: true, hash: "test", config: { agents: { defaults: { model: { primary } } } } } : responses[method];
    }
    finally {
      pending--;
    }
  });
  const services = createAgentRuntimeServices({ homePath, client: { readJson: vi.fn(async () => { throw Error("Unexpected Hermes read"); }), requestJson: vi.fn(async () => ({ ok: true })) }, openClawRpc: { call, close: vi.fn(async () => { }) }, hostControl: { status: vi.fn(async () => ({ hermes: { installed: true, running: false }, openclaw: { installed: true, running: true } })), switch: vi.fn(async () => { }), stop: vi.fn(async () => { }) } });
  return { services, call, counters: () => ({ refused, peak }) };
}
describe("unified runtime observation single flight", () => {
  it("shares concurrent Chat, AI inventory and Settings reads without exhausting bounded RPC", async () => {
    const f = await fixture();
    const snapshots = await Promise.all(Array.from({ length: 4 }, () => f.services.source(AbortSignal.timeout(1000))));
    expect(f.counters().refused).toBe(0);
    expect(f.call).toHaveBeenCalledTimes(5);
    for (const s of snapshots) {
      expect(s.messaging.configured).toBe(true);
      expect(s.runtime.options.find(r => r.id === "openclaw")?.health).toBe("healthy");
    }
  });
});
function snapshot(model = "before"): AgentRuntimeSettingsSnapshot { return { runtime: { selected: "openclaw", options: [] }, providers: [], messaging: { runtime: "openclaw", provider: "anthropic", model, configured: true } }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
describe("runtime observation lifecycle", () => {
  it("waits for Node AbortError observations to settle before mutating", async () => {
    const work = deferred<AgentRuntimeSettingsSnapshot>();
    const observation = createRuntimeObservation(async (signal) => {
      await work.promise;
      if (signal.aborted) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      return snapshot();
    });
    const reading = observation.source(new AbortController().signal);
    const cancelled = expect(reading).rejects.toMatchObject({ kind: "runtime_unavailable" });
    await Promise.resolve();
    const operation = vi.fn(async () => {});
    const updating = observation.mutate(operation);
    await cancelled;
    expect(operation).not.toHaveBeenCalled();
    work.resolve(snapshot());
    await updating;
    expect(operation).toHaveBeenCalledOnce();
  });

  it("preserves unexpected programming failures while draining before mutation", async () => {
    const work = deferred<AgentRuntimeSettingsSnapshot>();
    const observation = createRuntimeObservation(async () => work.promise);
    const reading = observation.source(new AbortController().signal);
    const cancelled = expect(reading).rejects.toMatchObject({ kind: "runtime_unavailable" });
    await Promise.resolve();
    const operation = vi.fn(async () => {});
    const updating = observation.mutate(operation);
    const failed = expect(updating).rejects.toBeInstanceOf(TypeError);
    await cancelled;
    work.reject(new TypeError("synthetic programming failure"));
    await failed;
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not cache settled snapshots or share mutable results", async () => {
    const read = vi.fn(async () => snapshot());
    const observation = createRuntimeObservation(read);
    const [a, b] = await Promise.all([observation.source(new AbortController().signal), observation.source(new AbortController().signal)]);
    a.messaging.model = "modified";
    expect(b.messaging.model).toBe("before");
    await observation.source(new AbortController().signal);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("isolates a caller abort from another reader", async () => {
    const work = deferred<AgentRuntimeSettingsSnapshot>();
    let sharedSignal: AbortSignal | undefined;
    const observation = createRuntimeObservation(async (signal) => { sharedSignal = signal; return work.promise; });
    const caller = new AbortController();
    const first = observation.source(caller.signal);
    const second = observation.source(new AbortController().signal);
    const rejected = expect(first).rejects.toThrow();
    await Promise.resolve();
    caller.abort();
    await rejected;
    expect(sharedSignal?.aborted).toBe(false);
    work.resolve(snapshot());
    expect((await second).messaging.model).toBe("before");
  });
  it("retains an occupied flight until an abort-ignoring dependency drains", async () => {
    const work = deferred<AgentRuntimeSettingsSnapshot>();
    const read = vi.fn(async () => work.promise);
    const observation = createRuntimeObservation(read);
    const caller = new AbortController();
    const first = observation.source(caller.signal);
    const rejected = expect(first).rejects.toThrow();
    await Promise.resolve();
    caller.abort();
    await rejected;
    await expect(observation.source(new AbortController().signal)).rejects.toMatchObject({ kind: "runtime_unavailable" });
    expect(read).toHaveBeenCalledTimes(1);
    work.resolve(snapshot());
    await work.promise;
    await Promise.resolve();
  });
  it("bounds concurrent observation waiters", async () => {
    const work = deferred<AgentRuntimeSettingsSnapshot>();
    const observation = createRuntimeObservation(async () => work.promise);
    const readers = Array.from({ length: 64 }, () => observation.source(new AbortController().signal));
    await expect(observation.source(new AbortController().signal)).rejects.toMatchObject({ kind: "agent_config_conflict" });
    work.resolve(snapshot());
    await Promise.all(readers);
  });
  it("aborts old reads and blocks new ones throughout selection mutation", async () => {
    const work = deferred<AgentRuntimeSettingsSnapshot>();
    const mutation = deferred<void>();
    let next = "before";
    const read = vi.fn(async () => read.mock.calls.length === 1 ? work.promise : snapshot(next));
    const observation = createRuntimeObservation(read);
    const old = observation.source(new AbortController().signal);
    const rejected = expect(old).rejects.toThrow();
    await Promise.resolve();
    const operation = vi.fn(async () => { next = "after"; return mutation.promise; });
    const updating = observation.mutate(operation);
    await rejected;
    expect(operation).not.toHaveBeenCalled();
    await expect(observation.source(new AbortController().signal)).rejects.toMatchObject({ kind: "runtime_unavailable" });
    work.resolve(snapshot());
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    await expect(observation.source(new AbortController().signal)).rejects.toMatchObject({ kind: "runtime_unavailable" });
    mutation.resolve();
    await updating;
    expect((await observation.source(new AbortController().signal)).messaging.model).toBe("after");
  });
  it("clears a failed observation and releases a failed mutation fence", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("synthetic")).mockResolvedValue(snapshot());
    const observation = createRuntimeObservation(read);
    await expect(observation.source(new AbortController().signal)).rejects.toThrow("synthetic");
    await expect(observation.mutate(async () => { throw new Error("synthetic mutation"); })).rejects.toThrow("synthetic mutation");
    await expect(observation.source(new AbortController().signal)).resolves.toEqual(snapshot());
  });
  it("closes without allowing new reads or mutations", async () => {
    const observation = createRuntimeObservation(async () => snapshot());
    await observation.close();
    await expect(observation.source(new AbortController().signal)).rejects.toMatchObject({ kind: "runtime_unavailable" });
    await expect(observation.mutate(async () => { })).rejects.toMatchObject({ kind: "agent_config_conflict" });
  });
  it("bounds a dependency timeout without starting overlapping work or a mutation", async () => {
    vi.useFakeTimers();
    try {
      const work = deferred<AgentRuntimeSettingsSnapshot>();
      const read = vi.fn(async () => work.promise);
      const observation = createRuntimeObservation(read);
      const first = observation.source(new AbortController().signal);
      const rejected = expect(first).rejects.toMatchObject({ kind: "runtime_unavailable" });
      await vi.advanceTimersByTimeAsync(6500);
      await rejected;
      await expect(observation.source(new AbortController().signal)).rejects.toMatchObject({ kind: "runtime_unavailable" });
      const operation = vi.fn(async () => { });
      const updating = observation.mutate(operation);
      const denied = expect(updating).rejects.toMatchObject({ kind: "runtime_unavailable" });
      await vi.advanceTimersByTimeAsync(6500);
      await denied;
      expect(operation).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
      work.resolve(snapshot());
      await work.promise;
    }
    finally {
      vi.useRealTimers();
    }
  });
});
