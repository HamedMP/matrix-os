import { describe, expect, it, vi } from "vitest";
import { createScopeRuntimeChatProviderAdapter } from "../../packages/gateway/src/collaboration/scope-runtime-chat-adapter.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const runtimeHandle = "runtime_22222222222222222222222222222222";

describe("scope runtime canonical Chat adapter", () => {
  it("runs visible text in the exact fixed-profile generation and stops it", async () => {
    const client = {
      capability: () => ({
        available: true as const,
        profileId: "scope-runtime-chat-v1",
        executionGeneration: "7",
        supportedAdapters: [{ adapterId: "claude-code", harnessVersion: "2.1.240", workloads: ["chat_ai" as const] }],
      }),
      createRuntime: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", state: "running" as const })),
      runChat: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", text: "Scoped answer" })),
      stopRuntime: vi.fn(async () => ({ state: "stopped" })),
    };
    const adapter = createScopeRuntimeChatProviderAdapter({
      client,
      scopeId,
      executionGeneration: "7",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    });
    const events = [];
    for await (const event of adapter.start(runInput())) events.push(event);

    expect(client.createRuntime).toHaveBeenCalledWith({
      scopeHandle: "scope_10000000000040008000000000000001",
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    });
    expect(client.runChat).toHaveBeenCalledWith({
      runtimeHandle,
      executionGeneration: "7",
      model: "claude-opus-4-6",
      prompt: "Shared prompt",
    });
    expect(events).toMatchObject([
      { type: "state.updated", state: { runtimeHandle, executionGeneration: "7" } },
      { type: "assistant.delta", delta: "Scoped answer" },
      { type: "run.completed", outcome: "completed" },
    ]);
    expect(client.stopRuntime).toHaveBeenCalledWith({ runtimeHandle });
  });

  it("fails closed before launch for stale generations and owner-context inputs", async () => {
    const client = {
      capability: () => ({ available: false as const, reason: "supervisor_unavailable" as const }),
      createRuntime: vi.fn(),
      runChat: vi.fn(),
      stopRuntime: vi.fn(),
    };
    const adapter = createScopeRuntimeChatProviderAdapter({
      client,
      scopeId,
      executionGeneration: "7",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    });
    const unavailable = [];
    for await (const event of adapter.start(runInput())) unavailable.push(event);
    expect(unavailable).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
    expect(client.createRuntime).not.toHaveBeenCalled();

    const unsafe = [];
    for await (const event of adapter.start({ ...runInput(), executionRoot: "/home/matrix/home" })) unsafe.push(event);
    expect(unsafe).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
    expect(client.createRuntime).not.toHaveBeenCalled();
  });

  it("coalesces abort and explicit cancellation into one runtime stop", async () => {
    const abortController = new AbortController();
    let finishRun: ((value: { runtimeHandle: string; executionGeneration: string; text: string }) => void) | undefined;
    const client = {
      capability: () => ({
        available: true as const,
        profileId: "scope-runtime-chat-v1",
        executionGeneration: "7",
        supportedAdapters: [{ adapterId: "claude-code", harnessVersion: "2.1.240", workloads: ["chat_ai" as const] }],
      }),
      createRuntime: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", state: "running" as const })),
      runChat: vi.fn(() => new Promise<{ runtimeHandle: string; executionGeneration: string; text: string }>((resolve) => {
        finishRun = resolve;
      })),
      stopRuntime: vi.fn(async () => ({ state: "stopped" })),
    };
    const adapter = createScopeRuntimeChatProviderAdapter({
      client,
      scopeId,
      executionGeneration: "7",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    });
    const iterator = adapter.start({ ...runInput(), signal: abortController.signal });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "state.updated" } });
    const completion = iterator.next();
    await vi.waitFor(() => expect(client.runChat).toHaveBeenCalled());

    abortController.abort();
    await adapter.cancel?.({
      owner: { type: "personal", ownerId: "owner" },
      chatId: "chat_shared",
      runId: "run_shared",
      state: { runtimeHandle, executionGeneration: "7" },
    });
    finishRun?.({ runtimeHandle, executionGeneration: "7", text: "" });
    await completion;
    await iterator.return?.(undefined);

    expect(client.stopRuntime).toHaveBeenCalledTimes(1);
  });
});

function runInput() {
  return {
    owner: { type: "personal" as const, ownerId: "owner" },
    chatId: "chat_shared",
    turnId: "turn_shared",
    runId: "run_shared",
    prompt: "Shared prompt",
    parts: [{ type: "text" as const, text: "Shared prompt" }],
    selection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
    interactionMode: "default",
    permissionMode: "supervised",
    signal: new AbortController().signal,
  };
}
