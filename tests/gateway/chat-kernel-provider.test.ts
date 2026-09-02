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
    selection: { instanceId: "kernel_matrix_included", model: "claude-sonnet-5" },
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
        data: { result: "Hello", cost: 0, durationMs: 1, tokensIn: 1, tokensOut: 1 },
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
      undefined,
      expect.any(AbortController),
      { model: "claude-sonnet-5", accessSourceId: "matrix_included" },
    );
    expect(events).toEqual([
      { type: "state.updated", state: { sessionId: "session_1" } },
      { type: "assistant.delta", delta: "Hello" },
      { type: "tool.progress", toolCallId: "kernel_tool_1", label: "Read", status: "running" },
      { type: "tool.progress", toolCallId: "kernel_tool_1", label: "Read", status: "completed" },
      { type: "run.completed", outcome: "completed" },
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
});
