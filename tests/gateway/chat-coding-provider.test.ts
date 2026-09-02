import {
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  type AgentThreadEvent,
  type AgentThreadSnapshot,
} from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import type {
  CodingAgentThreadStore,
  CodingAgentTurnStore,
} from "../../packages/gateway/src/coding-agents/thread-store.js";

const owner = { type: "personal" as const, ownerId: "owner_coding" };
const occurredAt = "2026-08-26T00:00:00.000Z";

function input(overrides: Record<string, unknown> = {}) {
  return {
    owner,
    chatId: "chat_coding",
    turnId: "cturn_coding",
    runId: "run_coding",
    prompt: "ship it",
    parts: [{ type: "text" as const, text: "ship it" }],
    selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
    interactionMode: "default",
    permissionMode: "supervised",
    projectSlug: "matrix-os",
    worktreeId: "wt_feature",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function event(value: Omit<AgentThreadEvent, "eventId" | "threadId" | "occurredAt"> & {
  eventId: string;
  threadId?: string;
}): AgentThreadEvent {
  return AgentThreadEventSchema.parse({
    ...value,
    threadId: value.threadId ?? "thread_native",
    occurredAt,
  });
}

function snapshot(events: AgentThreadEvent[]): AgentThreadSnapshot {
  return AgentThreadSnapshotSchema.parse({
    thread: {
      id: "thread_native",
      providerId: "codex",
      title: "Canonical Chat",
      status: events.some((candidate) => candidate.type === "thread.completed") ? "completed" : "running",
      attention: "none",
      projectId: "matrix-os",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
    events: { items: events, hasMore: false, limit: 200 },
  });
}

type Sink = Parameters<CodingAgentThreadStore["registerEventSink"]>[0];

function fakeStore(initialEvents: AgentThreadEvent[]) {
  let sink: Sink | undefined;
  const createThread = vi.fn(async (_principal, request) => {
    expect(request).toMatchObject({
      providerId: "codex",
      projectId: "matrix-os",
      worktreeId: "wt_feature",
      model: "gpt-5.6-sol",
      modelOptions: [],
      mode: "default",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
    });
    return { snapshot: snapshot(initialEvents), existing: false };
  });
  const acceptTurn = vi.fn(async () => ({
    threadId: "thread_native",
    turnId: "turn_native",
    status: "accepted" as const,
    acceptedAt: occurredAt,
  }));
  const getThread = vi.fn(async () => snapshot(initialEvents));
  const abortThread = vi.fn(async () => snapshot([]));
  const steerTurn = vi.fn(async () => undefined);
  const submitApproval = vi.fn(async () => snapshot([]));
  const registerEventSink = vi.fn((candidate: Sink) => {
    sink = candidate;
    return { dispose: vi.fn() };
  });
  const store = {
    createThread,
    acceptTurn,
    getThread,
    abortThread,
    steerTurn,
    submitApproval,
    registerEventSink,
  } as unknown as CodingAgentThreadStore & CodingAgentTurnStore;
  return {
    store,
    createThread,
    acceptTurn,
    getThread,
    abortThread,
    steerTurn,
    submitApproval,
    publish(events: AgentThreadEvent[]) {
      sink?.({ ownerId: owner.ownerId, threadId: "thread_native", events });
    },
  };
}

describe("canonical coding Chat Provider adapter", () => {
  it("routes Pi through the shared coding seam with its exact model and enforceable sandbox", async () => {
    const createThread = vi.fn(async () => ({
      snapshot: {
        ...snapshot([event({ type: "thread.completed", eventId: "evt_pi_complete", outcome: "completed" })]),
        thread: { ...snapshot([]).thread, providerId: "pi" },
      },
      existing: false,
    }));
    const store = {
      createThread,
      acceptTurn: vi.fn(),
      getThread: vi.fn(),
      abortThread: vi.fn(),
      submitApproval: vi.fn(),
      registerEventSink: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as CodingAgentThreadStore & CodingAgentTurnStore;
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "pi", threads: store });

    for await (const _event of adapter.start(input({
      selection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" },
    }))) {
      // Consume completed run.
    }

    expect(adapter.driverKind).toBe("pi");
    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner.ownerId }),
      expect.objectContaining({
        providerId: "pi",
        model: "anthropic:claude-sonnet-5",
        approvalPolicy: "on_request",
        sandboxMode: "read_only",
      }),
    );
  });

  it.each([
    ["pi", "pi_default", "pi"],
    ["opencode", "opencode_default", "opencode"],
  ] as const)(
    "routes %s through the shared coding seam with its exact model and enforceable sandbox",
    async (providerId, instanceId, driverKind) => {
    const createThread = vi.fn(async () => ({
      snapshot: {
        ...snapshot([event({ type: "thread.completed", eventId: "evt_pi_complete", outcome: "completed" })]),
        thread: { ...snapshot([]).thread, providerId },
      },
      existing: false,
    }));
    const store = {
      createThread,
      acceptTurn: vi.fn(),
      getThread: vi.fn(),
      abortThread: vi.fn(),
      submitApproval: vi.fn(),
      registerEventSink: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as CodingAgentThreadStore & CodingAgentTurnStore;
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId, threads: store });

    for await (const _event of adapter.start(input({
      selection: { instanceId, model: "anthropic:claude-sonnet-5" },
    }))) {
      // Consume completed run.
    }

    expect(adapter.driverKind).toBe(driverKind);
    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner.ownerId }),
      expect.objectContaining({
        providerId,
        model: "anthropic:claude-sonnet-5",
        approvalPolicy: "on_request",
        sandboxMode: "read_only",
      }),
    );
    },
  );

  it.each([
    ["supervised", "on_request", "workspace_write"],
    ["auto", "on_failure", "workspace_write"],
    ["full_access", "never", "full_access"],
  ] as const)(
    "passes %s permission mode to the Codex runtime as %s/%s",
    async (permissionMode, approvalPolicy, sandboxMode) => {
      const createThread = vi.fn(async () => ({
        snapshot: snapshot([event({
          type: "thread.completed",
          eventId: `evt_complete_${permissionMode}`,
          outcome: "completed",
        })]),
        existing: false,
      }));
      const store = {
        createThread,
        acceptTurn: vi.fn(),
        getThread: vi.fn(),
        abortThread: vi.fn(),
        submitApproval: vi.fn(),
        registerEventSink: vi.fn(() => ({ dispose: vi.fn() })),
      } as unknown as CodingAgentThreadStore & CodingAgentTurnStore;
      const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: store });

      for await (const _event of adapter.start(input({ permissionMode }))) {
        // Consume the completed Run.
      }

      expect(createThread).toHaveBeenCalledWith(
        expect.objectContaining({ userId: owner.ownerId }),
        expect.objectContaining({ approvalPolicy, sandboxMode }),
      );
    },
  );

  it("projects a typed Codex tool lifecycle through the provider-neutral activity seam", async () => {
    const fake = fakeStore([]);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: fake.store });

    queueMicrotask(() => fake.publish([
      event({
        type: "tool.started",
        eventId: "evt_command_started",
        toolCallId: "tool_command",
        displayName: "Run focused tests",
        kind: "command",
        preview: "bun run test tests/desktop/canonical-chat-presentation.test.ts",
        previewKind: "command",
      }),
      event({
        type: "tool.output",
        eventId: "evt_command_output",
        toolCallId: "tool_command",
        text: "failed at /Users/private/project with API_TOKEN=secret-value",
        truncated: false,
      }),
      event({
        type: "tool.completed",
        eventId: "evt_command_failed",
        toolCallId: "tool_command",
        outcome: "failed",
      }),
      event({ type: "thread.completed", eventId: "evt_complete", outcome: "failed" }),
    ]));

    const events = [];
    for await (const candidate of adapter.start(input())) events.push(candidate);

    expect(events).toEqual([
      { type: "state.updated", state: { conversationId: "thread_native" } },
      {
        type: "agent.activity",
        activityId: "tool_command",
        kind: "command",
        label: "Run focused tests",
        status: "running",
        preview: "bun run test tests/desktop/canonical-chat-presentation.test.ts",
        previewKind: "command",
      },
      {
        type: "agent.activity",
        activityId: "tool_command",
        kind: "command",
        label: "Run focused tests",
        status: "failed",
        summary: "Command failed.",
        preview: "bun run test tests/desktop/canonical-chat-presentation.test.ts",
        previewKind: "command",
      },
      { type: "run.completed", outcome: "failed" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/secret-value|API_TOKEN|\/Users\/private|tool\.output/);
  });

  it("streams normalized Codex events from the shared Gateway thread seam", async () => {
    const started = event({
      type: "terminal.bound",
      eventId: "evt_terminal",
      terminalSessionId: "terminal_native",
      terminalSessionCreatedAt: occurredAt,
    });
    const fake = fakeStore([started]);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: fake.store });

    queueMicrotask(() => fake.publish([
      event({ type: "assistant.text.delta", eventId: "evt_delta", messageId: "msg_native", delta: "done" }),
      event({ type: "file.changed", eventId: "evt_file", path: "src/index.ts", changeKind: "updated" }),
      event({ type: "thread.completed", eventId: "evt_complete", outcome: "completed" }),
    ]));

    const events = [];
    for await (const candidate of adapter.start(input())) events.push(candidate);

    expect(events).toEqual([
      { type: "state.updated", state: { conversationId: "thread_native" } },
      { type: "terminal.bound", terminalSessionId: "terminal_native", terminalSessionCreatedAt: occurredAt },
      { type: "assistant.delta", messageId: "msg_native", delta: "done" },
      expect.objectContaining({ type: "resource.changed", resourceKind: "file", changeKind: "updated" }),
      { type: "run.completed", outcome: "completed" },
    ]);
    expect(fake.createThread).toHaveBeenCalledTimes(1);
  });

  it("preserves the bounded approval decisions needed by canonical Chat controls", async () => {
    const fake = fakeStore([]);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: fake.store });

    queueMicrotask(() => fake.publish([
      event({
        type: "approval.requested",
        eventId: "evt_approval",
        approval: {
          approvalId: "appr_command",
          threadId: "thread_native",
          title: "Run command",
          safeDescription: "Run a medium-risk command.",
          risk: "medium",
          actionKind: "command",
          allowedDecisions: ["approve", "approve_for_session", "decline"],
          correlationId: "corr_command",
        },
      }),
      event({
        type: "approval.resolved",
        eventId: "evt_approval_resolved",
        approvalId: "appr_command",
        decision: "approve_for_session",
      }),
      event({ type: "thread.completed", eventId: "evt_complete", outcome: "aborted" }),
    ]));

    const events = [];
    for await (const candidate of adapter.start(input())) events.push(candidate);

    expect(events).toContainEqual({
      type: "approval.requested",
      approvalId: "appr_command",
      title: "Run command",
      risk: "medium",
      allowedDecisions: ["approve", "approve_for_session", "decline"],
    });
    expect(events).toContainEqual({
      type: "approval.resolved",
      approvalId: "appr_command",
      decision: "approve_for_session",
    });
  });

  it("separates distinct Codex assistant message items for Markdown rendering", async () => {
    const fake = fakeStore([]);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: fake.store });

    queueMicrotask(() => fake.publish([
      event({
        type: "assistant.text.delta",
        eventId: "evt_commentary",
        messageId: "msg_commentary",
        delta: "I'll run the requested command.",
      }),
      event({
        type: "assistant.text.completed",
        eventId: "evt_commentary_complete",
        messageId: "msg_commentary",
      }),
      event({
        type: "assistant.text.delta",
        eventId: "evt_final",
        messageId: "msg_final",
        delta: "# Verification\n\n- Complete",
      }),
      event({
        type: "assistant.text.completed",
        eventId: "evt_final_complete",
        messageId: "msg_final",
      }),
      event({ type: "thread.completed", eventId: "evt_complete", outcome: "completed" }),
    ]));

    const events = [];
    for await (const candidate of adapter.start(input())) events.push(candidate);

    expect(events).toEqual([
      { type: "state.updated", state: { conversationId: "thread_native" } },
      { type: "assistant.delta", messageId: "msg_commentary", delta: "I'll run the requested command." },
      { type: "assistant.delta", messageId: "msg_final", delta: "# Verification\n\n- Complete" },
      { type: "run.completed", outcome: "completed" },
    ]);
  });

  it("resumes and cancels only the same persisted coding thread", async () => {
    const accepted = event({
      type: "turn.accepted",
      eventId: "evt_accepted",
      turnId: "turn_native",
      clientRequestId: "req_coding",
      acceptedAt: occurredAt,
    });
    const completed = event({ type: "thread.completed", eventId: "evt_complete", outcome: "completed" });
    const fake = fakeStore([accepted, completed]);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: fake.store });

    const events = [];
    for await (const candidate of adapter.resume!({
      ...input(),
      resumeState: { conversationId: "thread_native" },
    })) events.push(candidate);
    expect(events).toEqual([{ type: "run.completed", outcome: "completed" }]);
    expect(fake.acceptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner.ownerId }),
      "thread_native",
      expect.objectContaining({ message: "ship it" }),
    );

    await adapter.cancel!({
      owner,
      chatId: "chat_coding",
      runId: "run_coding",
      state: { conversationId: "thread_native" },
    });
    expect(fake.abortThread).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner.ownerId }),
      "thread_native",
      "req_coding",
    );
  });

  it("steers only the registered active canonical Run through the legacy thread seam", async () => {
    const fake = fakeStore([]);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: fake.store });
    const iterator = adapter.start(input())[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "state.updated", state: { conversationId: "thread_native" } },
    });
    await expect(adapter.steer!({
      owner,
      chatId: "chat_coding",
      runId: "run_coding",
      turnId: "cturn_coding",
      clientRequestId: "req_coding_steer",
      prompt: "Focus on the failing test.",
      parts: [{ type: "text", text: "Focus on the failing test." }],
    })).resolves.toBeUndefined();
    expect(fake.steerTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner.ownerId }),
      "thread_native",
      {
        message: "Focus on the failing test.",
        clientRequestId: "req_coding_steer",
      },
    );
    await expect(adapter.steer!({
      owner,
      chatId: "chat_coding",
      runId: "run_other",
      turnId: "cturn_other",
      clientRequestId: "req_coding_steer_other",
      prompt: "Stale.",
      parts: [{ type: "text", text: "Stale." }],
    })).rejects.toThrow("steering Run unavailable");

    fake.publish([event({ type: "thread.completed", eventId: "evt_steer_complete", outcome: "completed" })]);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "run.completed", outcome: "completed" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(adapter.steer!({
      owner,
      chatId: "chat_coding",
      runId: "run_coding",
      turnId: "cturn_coding",
      clientRequestId: "req_coding_steer_terminal",
      prompt: "Too late.",
      parts: [{ type: "text", text: "Too late." }],
    })).rejects.toThrow("steering Run unavailable");
  });

  it("submits canonical approval decisions through the same persisted coding thread", async () => {
    const fake = fakeStore([event({
      type: "approval.requested",
      eventId: "evt_approval",
      approval: {
        approvalId: "appr_command",
        threadId: "thread_native",
        title: "Run command",
        safeDescription: "The agent wants to run a workspace command.",
        risk: "medium",
        actionKind: "command",
        allowedDecisions: ["approve_for_session", "decline"],
        correlationId: "corr_command",
      },
    })]);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: fake.store });

    await adapter.submitApproval!({
      owner,
      chatId: "chat_coding",
      runId: "run_coding",
      approvalId: "appr_command",
      decision: "approve_for_session",
      clientRequestId: "req_approval",
      state: { conversationId: "thread_native" },
    });

    expect(fake.submitApproval).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner.ownerId }),
      "thread_native",
      "appr_command",
      { decision: "approve_for_session", clientRequestId: "req_approval", correlationId: "corr_command" },
    );
  });

  it("uses live sink events when the bounded snapshot no longer contains the accepted marker", async () => {
    let sink: Sink | undefined;
    const accepted = event({
      type: "turn.accepted",
      eventId: "evt_live_accepted",
      turnId: "turn_native",
      clientRequestId: "req_coding",
      acceptedAt: occurredAt,
    });
    const completed = event({ type: "thread.completed", eventId: "evt_live_complete", outcome: "completed" });
    const stale = event({
      type: "assistant.text.delta",
      eventId: "evt_stale_delta",
      messageId: "msg_stale",
      delta: "stale",
    });
    const store = {
      createThread: vi.fn(),
      acceptTurn: vi.fn(async () => {
        sink?.({ ownerId: owner.ownerId, threadId: "thread_native", events: [accepted, completed] });
        return {
          threadId: "thread_native",
          turnId: "turn_native",
          status: "accepted" as const,
          acceptedAt: occurredAt,
        };
      }),
      getThread: vi.fn(async () => snapshot([stale])),
      abortThread: vi.fn(),
      registerEventSink: vi.fn((candidate: Sink) => {
        sink = candidate;
        return { dispose: vi.fn() };
      }),
    } as unknown as CodingAgentThreadStore & CodingAgentTurnStore;
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: store });

    const events = [];
    for await (const candidate of adapter.resume!({
      ...input(),
      resumeState: { conversationId: "thread_native" },
    })) events.push(candidate);

    expect(events).toEqual([{ type: "run.completed", outcome: "completed" }]);
  });

  it("drains a healthy long Codex stream without treating total event IDs as backlog", async () => {
    let sink: Sink | undefined;
    const store = {
      createThread: vi.fn(async () => {
        let next = 0;
        const publishBatch = () => {
          const events = Array.from({ length: Math.min(10, 1_100 - next) }, (_, offset) => event({
            type: "assistant.text.delta",
            eventId: `evt_long_${next + offset}`,
            messageId: "msg_native",
            delta: "x",
          }));
          next += events.length;
          sink?.({ ownerId: owner.ownerId, threadId: "thread_native", events });
          if (next < 1_100) {
            setTimeout(publishBatch, 0);
          } else {
            setTimeout(() => sink?.({
              ownerId: owner.ownerId,
              threadId: "thread_native",
              events: [event({
                type: "thread.completed",
                eventId: "evt_long_complete",
                outcome: "completed",
              })],
            }), 0);
          }
        };
        setTimeout(publishBatch, 0);
        return { snapshot: snapshot([]), existing: false };
      }),
      acceptTurn: vi.fn(),
      getThread: vi.fn(),
      abortThread: vi.fn(),
      registerEventSink: vi.fn((candidate: Sink) => {
        sink = candidate;
        return { dispose: vi.fn() };
      }),
    } as unknown as CodingAgentThreadStore & CodingAgentTurnStore;
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: store });
    const events = [];

    for await (const candidate of adapter.start(input({ signal: AbortSignal.timeout(5_000) }))) {
      events.push(candidate);
    }

    expect(events.filter((candidate) => candidate.type === "assistant.delta")
      .map((candidate) => candidate.type === "assistant.delta" ? candidate.delta : "")
      .join("")).toBe("x".repeat(1_100));
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });

  it("surfaces event overflow even when the shared thread store isolates sink failures", async () => {
    let sink: Sink | undefined;
    const overflow = Array.from({ length: 501 }, (_, index) => event({
      type: "assistant.text.delta",
      eventId: `evt_overflow_${index}`,
      messageId: "msg_native",
      delta: "x",
    }));
    const store = {
      createThread: vi.fn(async () => {
        setTimeout(() => {
          sink?.({ ownerId: owner.ownerId, threadId: "thread_native", events: overflow });
        }, 0);
        return { snapshot: snapshot([]), existing: false };
      }),
      acceptTurn: vi.fn(),
      getThread: vi.fn(),
      abortThread: vi.fn(),
      registerEventSink: vi.fn((candidate: Sink) => {
        sink = candidate;
        return { dispose: vi.fn() };
      }),
    } as unknown as CodingAgentThreadStore & CodingAgentTurnStore;
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: store });

    await expect(async () => {
      for await (const _event of adapter.start(input({ signal: AbortSignal.timeout(100) }))) {
        // consume
      }
    }).rejects.toThrow("event buffer exceeded");
  });
});
