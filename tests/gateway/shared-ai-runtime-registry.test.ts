import { describe, expect, it } from "vitest";
import { SharedAiRuntimeRegistry } from "../../packages/gateway/src/collaboration/shared-ai-runtime-registry.js";

const runtime = (suffix: string) => `runtime_${suffix.padStart(32, "0")}`;

describe("shared AI runtime registry", () => {
  it("authorizes only the exact active runtime generation, action, and selected model", () => {
    const registry = new SharedAiRuntimeRegistry({ now: () => new Date("2026-09-10T00:00:00.000Z") });
    registry.bind({
      runtimeHandle: runtime("1"),
      scopeId: "10000000-0000-4000-8000-000000000001",
      chatId: "chat_1",
      ownerId: "owner_1",
      actorId: "editor_1",
      executionGeneration: "7",
      accessSourceId: "owner_anthropic_key",
    });
    registry.selectModel(runtime("1"), "claude-opus-4-6");

    expect(registry.authorize({
      runtimeHandle: runtime("1"), executionGeneration: "7",
      action: "inference.messages", modelId: "claude-opus-4-6",
    })).toEqual({
      allowed: true,
      accessSourceId: "owner_anthropic_key",
      allowedModelIds: ["claude-opus-4-6"],
      allowedEgressOrigins: [],
    });
    expect(registry.authorize({
      runtimeHandle: runtime("1"), executionGeneration: "8",
      action: "inference.messages", modelId: "claude-opus-4-6",
    })).toEqual({ allowed: false });
    expect(registry.authorize({
      runtimeHandle: runtime("1"), executionGeneration: "7",
      action: "egress.fetch", url: "https://example.com",
    })).toEqual({ allowed: false });

    registry.release(runtime("1"));
    expect(registry.authorize({
      runtimeHandle: runtime("1"), executionGeneration: "7", action: "inference.messages",
    })).toEqual({ allowed: false });
  });

  it("is bounded and evicts expired entries before rejecting new active work", () => {
    let current = new Date("2026-09-10T00:00:00.000Z");
    const registry = new SharedAiRuntimeRegistry({ now: () => current, capacity: 2, ttlMs: 1_000 });
    const bind = (index: number) => registry.bind({
      runtimeHandle: runtime(String(index)),
      scopeId: "10000000-0000-4000-8000-000000000001",
      chatId: "chat_1",
      ownerId: "owner_1",
      actorId: "editor_1",
      executionGeneration: "7",
      accessSourceId: "matrix_included",
    });
    bind(1);
    bind(2);
    expect(() => bind(3)).toThrowError("Shared AI runtime registry is at capacity");
    current = new Date("2026-09-10T00:00:02.000Z");
    expect(() => bind(3)).not.toThrow();
    expect(registry.size).toBe(1);
    registry.shutdown();
    expect(registry.size).toBe(0);
  });
});
