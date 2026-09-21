import { describe, expect, it, vi } from "vitest";
import { createScopeRuntimeChatProviderAdapter } from "../../packages/gateway/src/collaboration/scope-runtime-chat-adapter.js";
const scopeId = "10000000-0000-4000-8000-000000000001";
const runtimeHandle = "runtime_22222222222222222222222222222222";
const sandbox = {
  version: 1 as const,
  scopeHandle: "scope_10000000000040008000000000000001",
  actorId: "user_member",
  worktree: { hostPath: "/home/matrix/home/projects/launch-site", mode: "rw" as const, fingerprint: "a".repeat(64) },
  network: "none" as const,
};
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
      sandbox,
    });
    const events = [];
    for await (const event of adapter.start(runInput())) events.push(event);
    expect(client.createRuntime).toHaveBeenCalledWith({
      scopeHandle: "scope_10000000000040008000000000000001",
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
      sandbox,
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
  it("maps the immutable Codex binding to the pinned native adapter and OpenAI result", async () => {
    const client = {
      capability: () => ({
        available: true as const,
        profileId: "scope-runtime-chat-v1",
        executionGeneration: "7",
        supportedAdapters: [{ adapterId: "codex", harnessVersion: "0.154.0", workloads: ["chat_ai" as const] }],
      }),
      createRuntime: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", state: "running" as const })),
      runChat: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", text: "Codex answer" })),
      stopRuntime: vi.fn(async () => ({ state: "stopped" })),
    };
    const adapter = createScopeRuntimeChatProviderAdapter({
      client,
      scopeId,
      executionGeneration: "7",
      adapterId: "codex",
      harnessVersion: "0.154.0",
      sandbox,
    });
    const events = [];
    for await (const event of adapter.start({
      ...runInput(),
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
    })) events.push(event);

    expect(adapter.driverKind).toBe("codex");
    expect(client.createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      adapterId: "codex",
      harnessVersion: "0.154.0",
    }));
    expect(client.runChat).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-sol" }));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed", provider: "openai" });
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
    const resumed = [];
    for await (const event of adapter.start({ ...runInput(), resumeState: { private: true } })) resumed.push(event);
    expect(resumed).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
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
      sandbox,
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
  it("forwards the authoritative sandbox manifest and never launches without one", async () => {
    const client = {
      capability: () => ({
        available: true as const,
        profileId: "scope-runtime-chat-v1",
        executionGeneration: "7",
        supportedAdapters: [{ adapterId: "claude-code", harnessVersion: "2.1.240", workloads: ["chat_ai" as const] }],
        sandbox: { policyVersion: 1, policyDigest: "c".repeat(64), workloads: ["chat_ai" as const] },
      }),
      createRuntime: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", state: "running" as const })),
      runChat: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", text: "Sandboxed answer" })),
      stopRuntime: vi.fn(async () => ({ state: "stopped" })),
    };
    const base = { client, scopeId, executionGeneration: "7", adapterId: "claude-code" as const, harnessVersion: "2.1.240" };
    const bare = [];
    for await (const event of createScopeRuntimeChatProviderAdapter(base).start(runInput())) bare.push(event);
    expect(bare).toMatchObject([{ type: "run.completed", outcome: "failed", error: { code: "run_unavailable" } }]);
    const foreign = [];
    for await (const event of createScopeRuntimeChatProviderAdapter({
      ...base, sandbox: { ...sandbox, scopeHandle: "scope_20000000000040008000000000000002" },
    }).start(runInput())) foreign.push(event);
    expect(foreign).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
    expect(client.createRuntime).not.toHaveBeenCalled();
    const events = [];
    for await (const event of createScopeRuntimeChatProviderAdapter({ ...base, sandbox }).start(runInput())) events.push(event);
    expect(client.createRuntime).toHaveBeenCalledTimes(1);
    expect(client.createRuntime.mock.calls[0]![0]).toMatchObject({ scopeHandle: sandbox.scopeHandle, workload: "chat_ai", sandbox });
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
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
