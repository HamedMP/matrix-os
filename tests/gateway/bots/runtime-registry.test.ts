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
  ...overrides,
});

describe("bot runtime registry", () => {
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
