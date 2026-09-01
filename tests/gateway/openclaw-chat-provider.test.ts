import { describe, expect, it, vi } from "vitest";
import {
  createOpenClawChatProviderAdapter,
  type OpenClawChatState,
} from "../../packages/gateway/src/chat/openclaw-provider-adapter.js";
import type {
  OpenClawRpcCallOptions,
  OpenClawRpcClient,
  OpenClawRpcEvent,
} from "../../packages/gateway/src/agent-config/openclaw-rpc.js";

class FakeRpc implements OpenClawRpcClient {
  readonly calls: Array<{ method: string; params: unknown; options?: OpenClawRpcCallOptions }> = [];
  private readonly listeners = new Set<(event: OpenClawRpcEvent) => void>();
  agentRun = Promise.withResolvers<unknown>();
  autoAccept = true;
  pendingAgentOptions?: OpenClawRpcCallOptions;
  accepted = {
    runId: "openclaw-run-1",
    sessionKey: "agent:main:chat-openclaw",
    agentId: "main",
    status: "accepted" as const,
    acceptedAt: 1_789_000_000_000,
  };

  call = vi.fn(async (
    method: string,
    params: unknown,
    _signal: AbortSignal,
    options?: OpenClawRpcCallOptions,
  ): Promise<unknown> => {
    this.calls.push({ method, params, options });
    if (method === "agent") {
      this.pendingAgentOptions = options;
      if (this.autoAccept) options?.onAccepted?.(this.accepted);
      return this.agentRun.promise;
    }
    if (method === "chat.abort") return { ok: true, aborted: true, runIds: [this.accepted.runId] };
    throw new Error("unexpected method");
  });

  subscribe(listener: (event: OpenClawRpcEvent) => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(payload: unknown) {
    this.pendingAgentOptions?.onEvent?.({ event: "agent", payload });
    for (const listener of this.listeners) listener({ event: "agent", payload });
  }

  accept() {
    this.pendingAgentOptions?.onAccepted?.(this.accepted);
  }

  async close() {}
}

const baseInput = {
  owner: { type: "personal" as const, ownerId: "owner_openclaw" },
  chatId: "chat_openclaw",
  turnId: "cturn_openclaw",
  runId: "canonical-run-1",
  prompt: "hello",
  parts: [{ type: "text" as const, text: "hello" }],
  selection: { instanceId: "openclaw_default", model: "openai:gpt-5.4" },
  interactionMode: "default",
  permissionMode: "full_access",
  executionRoot: "/safe/project",
  signal: new AbortController().signal,
};

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function agentEvent(
  stream: string,
  data: Record<string, unknown>,
  seq: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    runId: "openclaw-run-1",
    sessionKey: "agent:main:chat-openclaw",
    agentId: "main",
    seq,
    stream,
    ts: 1_789_000_000_000 + seq,
    data,
    ...overrides,
  };
}

describe("OpenClaw canonical Chat Provider adapter", () => {
  it("uses agent expectFinal and projects assistant, tool, lifecycle, and durable state events", async () => {
    const rpc = new FakeRpc();
    const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
    const result = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1));

    expect(rpc.calls[0]).toMatchObject({
      method: "agent",
      params: {
        message: "hello",
        provider: "openai",
        model: "gpt-5.4",
        deliver: false,
        timeout: 120,
        idempotencyKey: "canonical-run-1",
      },
      options: { expectFinal: true, timeoutMs: 125_000 },
    });
    expect(rpc.calls[0]?.params).not.toHaveProperty("cwd");
    rpc.emit(agentEvent("lifecycle", { phase: "start", startedAt: 1 }, 1));
    rpc.emit(agentEvent("assistant", { delta: "Hello " }, 2));
    rpc.emit(agentEvent("assistant", { text: "world" }, 3));
    rpc.emit(agentEvent("tool", {
      phase: "start",
      name: "exec",
      toolCallId: "tool-1",
      args: { command: "PRIVATE_COMMAND" },
    }, 4));
    rpc.emit(agentEvent("tool", {
      phase: "update",
      name: "exec",
      toolCallId: "tool-1",
      partialResult: "PRIVATE_PROGRESS",
    }, 5));
    rpc.emit(agentEvent("tool", {
      phase: "result",
      name: "exec",
      toolCallId: "tool-1",
      result: "PRIVATE_RESULT",
    }, 6));
    rpc.emit(agentEvent("lifecycle", { phase: "end", endedAt: 2 }, 7));
    rpc.agentRun.resolve({ runId: "openclaw-run-1", status: "ok" });

    const events = await result;
    expect(events).toEqual(expect.arrayContaining([
      { type: "state.updated", state: { sessionKey: "agent:main:chat-openclaw", agentId: "main" } },
      { type: "assistant.delta", delta: "Hello " },
      { type: "assistant.delta", delta: "world" },
      expect.objectContaining({
        type: "agent.activity",
        activityId: "tool-1",
        kind: "command",
        label: "Run command",
        status: "running",
        preview: "PRIVATE_COMMAND",
        previewKind: "command",
      }),
      expect.objectContaining({ type: "agent.activity", activityId: "tool-1", status: "completed" }),
      { type: "run.completed", outcome: "completed" },
    ]));
    expect(JSON.stringify(events)).not.toContain("PRIVATE_PROGRESS");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_RESULT");
  });

  it("resumes with the adapter-private OpenClaw session key", async () => {
    const rpc = new FakeRpc();
    rpc.accepted = {
      ...rpc.accepted,
      runId: "openclaw-run-2",
      sessionKey: "agent:main:existing-chat",
    };
    const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
    const state: OpenClawChatState = { sessionKey: "agent:main:existing-chat", agentId: "main" };
    const result = collect(adapter.resume!({
      ...baseInput,
      runId: "canonical-run-2",
      resumeState: state,
    }));
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1));
    expect(rpc.calls[0]?.params).toMatchObject({
      sessionKey: "agent:main:existing-chat",
      idempotencyKey: "canonical-run-2",
    });
    rpc.emit(agentEvent("lifecycle", { phase: "end" }, 1, {
      runId: "openclaw-run-2",
      sessionKey: "agent:main:existing-chat",
    }));
    rpc.agentRun.resolve({ runId: "openclaw-run-2", status: "ok" });
    await expect(result).resolves.toContainEqual({ type: "run.completed", outcome: "completed" });
  });

  it("cancels an accepted run with chat.abort and the exact session identity", async () => {
    const rpc = new FakeRpc();
    const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
    const result = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1));

    await adapter.cancel!({
      owner: baseInput.owner,
      chatId: baseInput.chatId,
      runId: baseInput.runId,
      state: { sessionKey: "agent:main:chat-openclaw", agentId: "main" },
    });
    expect(rpc.calls[1]).toMatchObject({
      method: "chat.abort",
      params: {
        sessionKey: "agent:main:chat-openclaw",
        runId: "openclaw-run-1",
        agentId: "main",
      },
    });
    rpc.agentRun.resolve({ runId: "openclaw-run-1", status: "error", error: "aborted" });
    await expect(result).resolves.toContainEqual({ type: "run.completed", outcome: "aborted" });
  });

  it("retries chat.abort when cancellation races ahead of agent acceptance", async () => {
    const rpc = new FakeRpc();
    rpc.autoAccept = false;
    const controller = new AbortController();
    const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
    const result = collect(adapter.start({ ...baseInput, signal: controller.signal }));
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1));

    controller.abort();
    expect(rpc.calls).toHaveLength(1);
    rpc.accept();
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(2));
    expect(rpc.calls[1]).toMatchObject({
      method: "chat.abort",
      params: {
        sessionKey: "agent:main:chat-openclaw",
        runId: "openclaw-run-1",
        agentId: "main",
      },
    });
    rpc.agentRun.resolve({ runId: "openclaw-run-1", status: "error" });
    await expect(result).resolves.toContainEqual({ type: "run.completed", outcome: "aborted" });
  });

  it("maps lifecycle and RPC failures to a bounded generic client error", async () => {
    const rpc = new FakeRpc();
    const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
    const result = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1));
    rpc.emit(agentEvent("lifecycle", {
      phase: "error",
      error: "sk-provider-secret /home/private provider exploded",
    }, 1));
    rpc.agentRun.reject(new Error("sk-provider-secret /home/private provider exploded"));

    const events = await result;
    expect(events.at(-1)).toEqual({
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "run_failed",
        safeMessage: "The OpenClaw run failed.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
    expect(JSON.stringify(events)).not.toContain("provider-secret");
    expect(JSON.stringify(events)).not.toContain("/home/private");
  });

  it("fails safely when the bounded event buffer overflows", async () => {
    const rpc = new FakeRpc();
    const adapter = createOpenClawChatProviderAdapter({
      rpc,
      homePath: "/home/matrix/home",
      maxBufferedEvents: 2,
    });
    const result = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1));
    rpc.emit(agentEvent("assistant", { delta: "one" }, 1));
    rpc.emit(agentEvent("assistant", { delta: "two" }, 2));
    rpc.emit(agentEvent("assistant", { delta: "three" }, 3));
    rpc.agentRun.resolve({ runId: "openclaw-run-1", status: "ok" });

    const events = await result;
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      outcome: "failed",
      error: { code: "run_failed" },
    });
  });

  it("preserves the orchestrator-owned attachment references in the agent message", async () => {
    const rpc = new FakeRpc();
    const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
    const prompt = "Inspect the attachment.\n\nAttached files:\n- notes.txt: \"$MATRIX_HOME\"/'uploads/notes.txt'";
    const result = collect(adapter.start({
      ...baseInput,
      prompt,
      parts: [
        { type: "text" as const, text: "Inspect the attachment." },
        {
          type: "attachment_reference" as const,
          attachmentId: "attachment_file",
          kind: "file" as const,
          label: "notes.txt",
          mimeType: "text/plain",
          ownerReference: "uploads/notes.txt",
        },
      ],
    }));
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1));
    expect(rpc.calls[0]?.params).toMatchObject({ message: prompt });
    expect(rpc.calls[0]?.params).not.toHaveProperty("attachments");
    rpc.agentRun.resolve({ runId: "openclaw-run-1", status: "ok" });
    await expect(result).resolves.toContainEqual({ type: "run.completed", outcome: "completed" });
  });

  it("fails safely before RPC when the namespaced provider model is malformed", async () => {
    const rpc = new FakeRpc();
    const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
    const events = await collect(adapter.start({
      ...baseInput,
      selection: { ...baseInput.selection, model: "missing-provider-separator" },
    }));
    expect(rpc.calls).toHaveLength(0);
    expect(events).toEqual([expect.objectContaining({
      type: "run.completed",
      outcome: "failed",
      error: expect.objectContaining({ code: "run_failed" }),
    })]);
  });

  it("keeps read/search/write/bash previews safe and chronological", async () => {
    const rpc = new FakeRpc();
    const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
    const result = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1));
    rpc.emit(agentEvent("tool", {
      phase: "start", name: "read_file", toolCallId: "read-1", args: { path: "/safe/project/src/a.ts" },
    }, 1));
    rpc.emit(agentEvent("tool", {
      phase: "start", name: "search_files", toolCallId: "search-1", args: { query: "needle", path: "/safe/project/src" },
    }, 2));
    rpc.emit(agentEvent("tool", {
      phase: "start", name: "write_file", toolCallId: "write-1", args: { path: "/safe/project/src/b.ts" },
    }, 3));
    rpc.emit(agentEvent("tool", {
      phase: "start", name: "bash", toolCallId: "bash-1", args: { command: "pnpm test", cwd: "/safe/project" },
    }, 4));
    rpc.emit(agentEvent("tool", {
      phase: "result", name: "bash", toolCallId: "bash-1", result: { ok: true, output: "PRIVATE" },
    }, 5));
    rpc.agentRun.resolve({ runId: "openclaw-run-1", status: "ok" });

    const events = await result;
    const activities = events.filter((event): event is Record<string, unknown> =>
      typeof event === "object" && event !== null && (event as { type?: string }).type === "agent.activity");
    expect(activities).toMatchObject([
      { activityId: "read-1", label: "Read file", preview: "src/a.ts", previewKind: "path" },
      { activityId: "search-1", label: "Search files", preview: "needle", detail: "In: src" },
      { activityId: "write-1", label: "Update file", preview: "src/b.ts", previewKind: "path" },
      { activityId: "bash-1", label: "Run command", preview: "pnpm test", detail: "Working directory: .", status: "running" },
      { activityId: "bash-1", label: "Run command", preview: "pnpm test", detail: "Working directory: .", status: "completed" },
    ]);
    expect(JSON.stringify(activities)).not.toContain("PRIVATE");
  });

  it("marks a tool result failed when OpenClaw reports top-level isError", async () => {
    const rpc = new FakeRpc();
    const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
    const result = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1));
    rpc.emit(agentEvent("tool", {
      phase: "start",
      name: "read_file",
      toolCallId: "read-failed",
      args: { path: "/safe/project/missing.ts" },
    }, 1));
    rpc.emit(agentEvent("tool", {
      phase: "result",
      name: "read_file",
      toolCallId: "read-failed",
      isError: true,
      result: "PRIVATE_FAILURE_DETAIL",
    }, 2));
    rpc.agentRun.resolve({ runId: "openclaw-run-1", status: "ok" });

    const events = await result;
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.activity",
      activityId: "read-failed",
      status: "failed",
    }));
    expect(JSON.stringify(events)).not.toContain("PRIVATE_FAILURE_DETAIL");
  });
});
