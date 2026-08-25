import { describe, expect, it, vi } from "vitest";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import type { Dispatcher } from "../../packages/gateway/src/dispatcher.js";

const owner = { type: "personal" as const, ownerId: "owner_hermes" };

function input(overrides: Record<string, unknown> = {}) {
  return {
    owner,
    chatId: "chat_hermes",
    turnId: "cturn_hermes",
    runId: "run_hermes",
    prompt: "hello",
    parts: [{ type: "text" as const, text: "hello" }],
    selection: {
      instanceId: "hermes_default",
      model: "anthropic:claude-opus-4-6",
      options: [{ id: "effort", value: "high" }],
    },
    interactionMode: "default",
    permissionMode: "supervised",
    executionRoot: "/safe/project",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("Hermes canonical Chat Provider adapter", () => {
  it("normalizes Matrix kernel events and persists only opaque resume state", async () => {
    const dispatch = vi.fn<Dispatcher["dispatch"]>(async (_message, _sessionId, onEvent, context, _abort, overrides) => {
      expect(context).toEqual({ chatId: "chat_hermes" });
      expect(overrides).toEqual({
        model: "claude-opus-4-6",
        effort: "high",
        workingDirectory: "/safe/project",
      });
      await onEvent({ type: "init", sessionId: "native_session" });
      await onEvent({ type: "text", text: "hello" });
      await onEvent({ type: "tool_start", tool: "Read" });
      await onEvent({ type: "tool_end" });
      await onEvent({
        type: "result",
        data: { sessionId: "native_session", result: "hello", cost: 0, turns: 1, tokensIn: 1, tokensOut: 1 },
      });
    });
    const adapter = createHermesChatProviderAdapter({ dispatcher: { dispatch } as Pick<Dispatcher, "dispatch"> });

    const events = [];
    for await (const event of adapter.start(input())) events.push(event);

    expect(events).toEqual([
      { type: "state.updated", state: { sessionId: "native_session" } },
      { type: "assistant.delta", delta: "hello" },
      { type: "tool.progress", toolCallId: "kernel_tool_1", label: "Read", status: "running" },
      { type: "tool.progress", toolCallId: "kernel_tool_1", label: "Read", status: "completed" },
      { type: "run.completed", outcome: "completed" },
    ]);
    expect(adapter.parseState(adapter.serializeState({ sessionId: "native_session" })))
      .toEqual({ sessionId: "native_session" });
  });

  it("resumes only the same bounded session and rejects non-kernel model selections", async () => {
    const dispatch = vi.fn<Dispatcher["dispatch"]>(async (_message, sessionId, onEvent) => {
      expect(sessionId).toBe("native_resume");
      await onEvent({ type: "aborted" });
    });
    const adapter = createHermesChatProviderAdapter({ dispatcher: { dispatch } as Pick<Dispatcher, "dispatch"> });

    const events = [];
    for await (const event of adapter.resume!({
      ...input(),
      resumeState: { sessionId: "native_resume" },
    })) events.push(event);
    expect(events).toEqual([{ type: "run.completed", outcome: "aborted" }]);

    await expect(async () => {
      for await (const _event of adapter.start(input({
        selection: { instanceId: "hermes_default", model: "openai:gpt-5" },
      }))) {
        // consume
      }
    }).rejects.toThrow("Unsupported Matrix kernel selection");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("fails safely when the Matrix kernel outpaces the bounded event buffer", async () => {
    let providerSignal: AbortSignal | undefined;
    const dispatch = vi.fn<Dispatcher["dispatch"]>(async (_message, _sessionId, onEvent, _context, abort) => {
      providerSignal = abort.signal;
      for (let index = 0; index < 501; index += 1) {
        void onEvent({ type: "text", text: "x" });
      }
    });
    const adapter = createHermesChatProviderAdapter({ dispatcher: { dispatch } as Pick<Dispatcher, "dispatch"> });

    await expect(async () => {
      for await (const _event of adapter.start(input())) {
        // consume
      }
    }).rejects.toThrow("event buffer exceeded");
    expect(providerSignal?.aborted).toBe(true);
  });
});
