import { describe, expect, it, vi } from "vitest";
import { createKernelChatProviderAdapter } from "../../packages/gateway/src/chat/kernel-provider-adapter.js";
import type { Dispatcher } from "../../packages/gateway/src/dispatcher.js";

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    owner: { type: "personal" as const, ownerId: "owner_1" },
    chatId: "chat_1",
    turnId: "turn_1",
    runId: "run_1",
    prompt: "Hello Matrix",
    parts: [{ type: "text" as const, text: "Hello Matrix" }],
    selection: { instanceId: "kernel_owner_anthropic_key", model: "claude-sonnet-5" },
    interactionMode: "default",
    permissionMode: "full_access",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("kernel canonical Chat adapter", () => {
  it("streams dispatcher events and persists the Agent SDK resume session", async () => {
    const dispatch = vi.fn(async (_prompt, _sessionId, onEvent) => {
      await onEvent({ type: "init", sessionId: "session_1" });
      await onEvent({ type: "text", text: "Hello" });
      await onEvent({ type: "tool_start", tool: "Read" });
      await onEvent({ type: "tool_end", input: { path: "README.md" } });
      await onEvent({
        type: "result",
        data: {
          result: "Hello",
          cost: 0,
          durationMs: 1,
          tokensIn: 11,
          tokensOut: 3,
          provider: "anthropic",
        },
      });
    });
    const adapter = createKernelChatProviderAdapter({
      dispatcher: { dispatch } as unknown as Dispatcher,
    });

    const events = [];
    for await (const event of adapter.start(runInput())) events.push(event);

    expect(dispatch).toHaveBeenCalledWith(
      "Hello Matrix",
      undefined,
      expect.any(Function),
      {
        senderId: "owner_1",
        chatId: "chat_1",
        suppressAiGeneration: true,
      },
      expect.any(AbortController),
      { model: "claude-sonnet-5", accessSourceId: "owner_anthropic_key" },
    );
    expect(events).toEqual([
      { type: "state.updated", state: { sessionId: "session_1" } },
      { type: "assistant.delta", delta: "Hello" },
      { type: "tool.progress", toolCallId: "kernel_tool_1", label: "Read", status: "running" },
      { type: "tool.progress", toolCallId: "kernel_tool_1", label: "Read", status: "completed" },
      {
        type: "run.completed",
        outcome: "completed",
        provider: "anthropic",
        tokenUsage: { inputTokens: 11, outputTokens: 3 },
      },
    ]);
  });

  it("resumes the recorded session and aborts the dispatcher with the canonical signal", async () => {
    const dispatch = vi.fn(async (_prompt, sessionId, onEvent, _context, controller) => {
      expect(sessionId).toBe("session_existing");
      expect(controller.signal.aborted).toBe(true);
      await onEvent({ type: "aborted" });
    });
    const adapter = createKernelChatProviderAdapter({
      dispatcher: { dispatch } as unknown as Dispatcher,
    });
    const controller = new AbortController();
    controller.abort();
    const events = [];
    for await (const event of adapter.resume!({
      ...runInput({ signal: controller.signal }),
      resumeState: { sessionId: "session_existing" },
    })) events.push(event);

    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
  });

  it("binds an OpenRouter kernel run and resume to the exact credential generation and model", async () => {
    const dispatch = vi.fn(async (_prompt, sessionId, onEvent) => {
      await onEvent({ type: "init", sessionId: sessionId ?? "session_openrouter" });
      await onEvent({ type: "result", data: { result: "ok", cost: 0, durationMs: 1, tokensIn: 1, tokensOut: 1 } });
    });
    const adapter = createKernelChatProviderAdapter({ dispatcher: { dispatch } as unknown as Dispatcher });
    const generation = "11111111-1111-4111-8111-111111111111";
    const input = runInput({ selection: {
      instanceId: "kernel_owner_openrouter", model: "anthropic/claude-sonnet-5",
      options: [{ id: "credentialGeneration", value: generation }],
    } });
    for await (const _event of adapter.start(input)) { /* drain */ }
    for await (const _event of adapter.resume!({ ...input, resumeState: { sessionId: "session_openrouter" } })) { /* drain */ }
    expect(dispatch).toHaveBeenCalledTimes(2);
    for (const call of dispatch.mock.calls) {
      expect(call[5]).toMatchObject({ model: "anthropic/claude-sonnet-5", accessSourceId: "owner_openrouter",
        credentialGeneration: generation });
    }
  });

  it("refuses an OpenRouter kernel selection without its generation fingerprint", async () => {
    const dispatch = vi.fn();
    const adapter = createKernelChatProviderAdapter({ dispatcher: { dispatch } as unknown as Dispatcher });
    const input = runInput({ selection: {
      instanceId: "kernel_owner_openrouter", model: "anthropic/claude-sonnet-5",
    } });
    await expect(async () => {
      for await (const _event of adapter.start(input)) { /* drain */ }
    }).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
