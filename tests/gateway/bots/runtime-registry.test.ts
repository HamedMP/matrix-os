import { describe, expect, it } from "vitest";
import { BOT_RUNTIME_REGISTRY_CAPACITY, BotRuntimeRegistry, BotRuntimeRegistryError, type BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";

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
