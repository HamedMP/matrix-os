import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_RUNTIME_REGISTRY_CAPACITY, BotRuntimeRegistry, BotRuntimeRegistryError, type BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { startRuntimeHeartbeat } from "../../../packages/gateway/src/bots/runtime-heartbeat.js";

afterEach(() => vi.useRealTimers());

const handle = (n: number) => `runtime_${n.toString(16).padStart(32, "0")}`;
const binding = (overrides: Partial<BotRuntimeBinding> = {}): BotRuntimeBinding => ({
  runtimeHandle: handle(1),
  executionGeneration: "4",
  ownerId: "user_owner",
  botId: "bot_0123456789abcdef",
  chatId: "chat_direct1",
  taskId: "task_0123456789abcdef",
  runId: "run_one",
  rootFingerprint: "f".repeat(64),
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 4_096 },
  accessSourceId: "matrix_included",
  capabilities: ["artifact.write"],
  requestClass: "interactive",
  ...overrides,
});

describe("bot runtime registry", () => {
  it("blocks recovery only for the same owner and Chat until release or expiry", () => {
    let now = 0;
    const registry = new BotRuntimeRegistry({ now: () => now, ttlMs: 1000 });
    const value = binding(); registry.bind(value);
    expect(registry.hasChatRuntime(value.ownerId, value.chatId)).toBe(true);
    expect(registry.hasChatRuntime("other-owner", value.chatId)).toBe(false);
    expect(registry.hasChatRuntime(value.ownerId, "chat_other")).toBe(false);
    registry.cancelInference(value);
    expect(registry.hasChatRuntime(value.ownerId, value.chatId)).toBe(true);
    registry.release(value.runtimeHandle);
    expect(registry.hasChatRuntime(value.ownerId, value.chatId)).toBe(false);
    registry.bind(value); now = 1001;
    expect(registry.hasChatRuntime(value.ownerId, value.chatId)).toBe(false);
  });

  it.each(["release","replace","expire","shutdown"])("releases private tracking exactly once on %s without serializing callbacks", action => {
    let now=1000;const registry=new BotRuntimeRegistry({now:()=>now,ttlMs:10});
    const current=binding();const cleanup=vi.fn();registry.bind(current,cleanup);
    expect(registry.lookupRun(current)).toEqual(current);
    if(action==="release")registry.release(current.runtimeHandle);
    if(action==="replace")registry.bind({...current,executionGeneration:"5"});
    if(action==="expire"){now+=11;expect(registry.size).toBe(0);}
    if(action==="shutdown")registry.shutdown();
    expect(cleanup).toHaveBeenCalledOnce();registry.shutdown();expect(cleanup).toHaveBeenCalledOnce();
  });
  it("cancels inference only for an exact owner/chat/run/generation and keeps graceful broker authority", () => {
    const registry = new BotRuntimeRegistry();
    const first = binding(); const sibling = binding({ runtimeHandle: handle(2), ownerId: "other_owner", runId: "run_two" });
    registry.bind(first); registry.bind(sibling);
    const signal = registry.inferenceSignal(first)!;
    for (const mismatch of [{ ownerId: "wrong" }, { chatId: "wrong" }, { runId: "run_other" }, { executionGeneration: "3" }]) {
      expect(registry.inferenceSignal({ ...first, ...mismatch })).toBeNull();
      registry.cancelInference({ ...first, ...mismatch });
      expect(signal.aborted).toBe(false);
    }
    registry.cancelInference(first);
    expect(signal.aborted).toBe(true);
    expect(registry.inferenceSignal(sibling)?.aborted).toBe(false);
    expect(registry.lookupRun(first)).toEqual(first);
    expect(Object.keys(registry.lookup(first)!)).toEqual(Object.keys(first));
    registry.shutdown();
  });

  it("aborts released, replaced, expired and shutdown entries while a new generation stays live", () => {
    let now = 0; const registry = new BotRuntimeRegistry({ now: () => now, ttlMs: 1_000 });
    const first = binding(); registry.bind(first);
    const old = registry.inferenceSignal(first)!;
    const replacement = binding({ executionGeneration: "5", runId: "run_replacement" });
    registry.bind(replacement);
    expect(old.aborted).toBe(true);
    const fresh = registry.inferenceSignal(replacement)!;
    registry.cancelInference(first);
    expect(fresh.aborted).toBe(false);
    registry.release(first.runtimeHandle); registry.release(first.runtimeHandle);
    expect(fresh.aborted).toBe(true);
    registry.bind(replacement);
    const expired = registry.inferenceSignal(replacement)!;
    now = 1_001; expect(registry.size).toBe(0); expect(expired.aborted).toBe(true);
    registry.bind(replacement);
    const shutdown = registry.inferenceSignal(replacement)!;
    registry.shutdown(); expect(shutdown.aborted).toBe(true); expect(registry.size).toBe(0);
  });

  it("renews only an existing live binding without replacing its inference signal or capabilities", () => {
    let now = 0;
    const registry = new BotRuntimeRegistry({ now: () => now, ttlMs: 1_000 });
    const first = binding();
    registry.bind(first);
    const signal = registry.inferenceSignal(first);
    now = 900;
    expect(registry.renew({ ...first, capabilities: ["artifact.read"] })).toBe(true);
    expect(registry.inferenceSignal(first)).toBe(signal);
    expect(registry.lookupRun(first)?.capabilities).toEqual(["artifact.write"]);
    now = 1_100;
    expect(registry.lookupRun(first)).toEqual(first);
    now = 1_901;
    expect(registry.renew(first)).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(registry.lookupRun(first)).toBeNull();
  });

  it("refuses stale, foreign, drifted, cancelled and released renewals", () => {
    const registry = new BotRuntimeRegistry();
    const first = binding(); registry.bind(first);
    for (const mismatch of [
      { runtimeHandle: handle(2) }, { executionGeneration: "5" }, { ownerId: "other_owner" },
      { chatId: "chat_other" }, { runId: "run_other" }, { rootFingerprint: "0".repeat(64) },
    ]) expect(registry.renew({ ...first, ...mismatch })).toBe(false);
    registry.cancelInference(first);
    expect(registry.renew(first)).toBe(false);
    registry.release(first.runtimeHandle);
    expect(registry.renew(first)).toBe(false);
  });

  it("does not expose mutable route or capability references through lookup", () => {
    const registry = new BotRuntimeRegistry();
    const first = binding(); registry.bind(first);
    const viewed = registry.lookupRun(first)!;
    viewed.route.modelId = "changed-model";
    (viewed.capabilities as string[])[0] = "artifact.read";
    expect(registry.lookupRun(first)?.route.modelId).toBe(first.route.modelId);
    expect(registry.lookupRun(first)?.capabilities).toEqual(first.capabilities);
  });

  it("keeps the same inference signal across 31 minutes of renewal and fences it on Stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T00:00:00.000Z"));
    const registry = new BotRuntimeRegistry();
    const first = binding(); registry.bind(first);
    const signal = registry.inferenceSignal(first);
    const onFailure = vi.fn();
    const heartbeat = startRuntimeHeartbeat(async (renewalSignal) => {
      if (renewalSignal.aborted || !registry.renew(first)) throw new Error("renewal lost");
    }, onFailure);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(registry.inferenceSignal(first)).toBe(signal);
    expect(signal?.aborted).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
    await heartbeat.stop();
    registry.release(first.runtimeHandle);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registry.lookupRun(first)).toBeNull();
  });

  it("binds an owner Codex subscription only to its admitted Responses model and generation", () => {
    const registry = new BotRuntimeRegistry();
    registry.bind(binding({ accessSourceId: "owner_openai_profile", route: {
      api: "openai-responses", modelId: "gpt-5.6-luna", input: ["text", "image"], contextWindow: 128_000, maxOutputTokens: 8_192,
    } }));
    expect(registry.authorize({ runtimeHandle: handle(1), executionGeneration: "4", action: "inference.responses", modelId: "gpt-5.6-luna" }))
      .toMatchObject({ allowed: true, accessSourceId: "owner_openai_profile" });
    expect(registry.authorize({ runtimeHandle: handle(1), executionGeneration: "3", action: "inference.responses", modelId: "gpt-5.6-luna" })).toEqual({ allowed: false });
    expect(registry.authorize({ runtimeHandle: handle(1), executionGeneration: "4", action: "inference.responses", modelId: "gpt-6-astra" })).toEqual({ allowed: false });
    expect(registry.authorize({ runtimeHandle: handle(1), executionGeneration: "4", action: "inference.messages" })).toEqual({ allowed: false });
  });
  it("binds, looks up by generation and run, and authorizes only the route's action and model", () => {
    const registry = new BotRuntimeRegistry();
    registry.bind(binding());
    expect(registry.lookup({ runtimeHandle: handle(1), executionGeneration: "4" })).toMatchObject({ botId: "bot_0123456789abcdef" });
    expect(registry.lookup({ runtimeHandle: handle(1), executionGeneration: "3" })).toBeNull();
    expect(registry.lookupRun({ runtimeHandle: handle(1), executionGeneration: "4", runId: "run_other" })).toBeNull();
    expect(registry.authorize({ runtimeHandle: handle(1), executionGeneration: "4", action: "inference.messages", modelId: "claude-sonnet-5" }))
      .toEqual({ allowed: true, accessSourceId: "matrix_included", allowedModelIds: ["claude-sonnet-5"], allowedEgressOrigins: [] });
    expect(registry.authorize({ runtimeHandle: handle(1), executionGeneration: "4", action: "inference.messages", modelId: "claude-opus-5" })).toEqual({ allowed: false });
    expect(registry.authorize({ runtimeHandle: handle(1), executionGeneration: "4", action: "inference.responses" })).toEqual({ allowed: false });
    expect(registry.authorize({ runtimeHandle: handle(1), executionGeneration: "4", action: "egress.fetch" })).toEqual({ allowed: false });
    registry.release(handle(1));
    expect(registry.lookup({ runtimeHandle: handle(1), executionGeneration: "4" })).toBeNull();
  });

  it("refuses malformed bindings", () => {
    const registry = new BotRuntimeRegistry();
    expect(() => registry.bind(binding({ rootFingerprint: "nope" }))).toThrow(new BotRuntimeRegistryError("invalid_binding"));
    expect(() => registry.bind(binding({ capabilities: ["computer.act" as never] }))).toThrow(BotRuntimeRegistryError);
  });

  it("caps live bindings and sweeps expired ones before refusing capacity", () => {
    let now = 0;
    const registry = new BotRuntimeRegistry({ now: () => now, ttlMs: 1_000 });
    for (let n = 1; n <= BOT_RUNTIME_REGISTRY_CAPACITY; n += 1) registry.bind(binding({ runtimeHandle: handle(n) }));
    expect(() => registry.bind(binding({ runtimeHandle: handle(999) }))).toThrow(new BotRuntimeRegistryError("capacity_exceeded"));
    // Rebinding an existing handle is not new capacity.
    expect(() => registry.bind(binding({ runtimeHandle: handle(1) }))).not.toThrow();
    now = 2_000;
    expect(() => registry.bind(binding({ runtimeHandle: handle(999) }))).not.toThrow();
    expect(registry.size).toBe(1);
  });
});
