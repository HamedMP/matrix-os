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
  const registerEventSink = vi.fn((candidate: Sink) => {
    sink = candidate;
    return { dispose: vi.fn() };
  });
  const store = {
    createThread,
    acceptTurn,
    getThread,
    abortThread,
    registerEventSink,
  } as unknown as CodingAgentThreadStore & CodingAgentTurnStore;
  return {
    store,
    createThread,
    acceptTurn,
    getThread,
    abortThread,
    publish(events: AgentThreadEvent[]) {
      sink?.({ ownerId: owner.ownerId, threadId: "thread_native", events });
    },
  };
}

describe("canonical coding Chat Provider adapter", () => {
  it("streams normalized Codex events from the shared Gateway thread seam", async () => {
    const started = event({ type: "terminal.bound", eventId: "evt_terminal", terminalSessionId: "terminal_native" });
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
      { type: "terminal.bound", terminalSessionId: "terminal_native" },
      { type: "assistant.delta", delta: "done" },
      expect.objectContaining({ type: "resource.changed", resourceKind: "file", changeKind: "updated" }),
      { type: "run.completed", outcome: "completed" },
    ]);
    expect(fake.createThread).toHaveBeenCalledTimes(1);
  });

  it("preserves structured activity kinds and labels while unknown tools stay generic", async () => {
    const fake = fakeStore([
      event({
        type: "tool.started",
        eventId: "evt_plan_started",
        toolCallId: "tool_plan",
        displayName: "Update plan",
        kind: "plan",
      }),
      event({
        type: "tool.started",
        eventId: "evt_unknown_started",
        toolCallId: "tool_unknown",
        displayName: "Use extension",
        kind: "provider_extension",
      }),
      event({
        type: "tool.completed",
        eventId: "evt_plan_completed",
        toolCallId: "tool_plan",
        outcome: "success",
      }),
      event({
        type: "tool.completed",
        eventId: "evt_unknown_completed",
        toolCallId: "tool_unknown",
        outcome: "failed",
      }),
      event({ type: "thread.completed", eventId: "evt_activity_complete", outcome: "completed" }),
    ]);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: fake.store });

    const events = [];
    for await (const candidate of adapter.start(input())) events.push(candidate);

    expect(events).toEqual([
      { type: "state.updated", state: { conversationId: "thread_native" } },
      {
        type: "agent.activity",
        activityId: "tool_plan",
        kind: "plan",
        label: "Update plan",
        status: "running",
      },
      {
        type: "tool.progress",
        toolCallId: "tool_unknown",
        label: "Use extension",
        status: "running",
      },
      {
        type: "agent.activity",
        activityId: "tool_plan",
        kind: "plan",
        label: "Update plan",
        status: "completed",
      },
      {
        type: "tool.progress",
        toolCallId: "tool_unknown",
        label: "Use extension",
        status: "failed",
      },
      { type: "run.completed", outcome: "completed" },
    ]);
  });

  it("normalizes legacy persisted tool kinds without losing generic compatibility", async () => {
    const fake = fakeStore([
      event({
        type: "tool.started",
        eventId: "evt_legacy_tool",
        toolCallId: "legacy_tool",
        displayName: "Use tool",
        kind: "tool",
      }),
      event({
        type: "tool.started",
        eventId: "evt_legacy_agent",
        toolCallId: "legacy_agent",
        displayName: "Coordinate agents",
        kind: "agent",
      }),
      event({
        type: "tool.started",
        eventId: "evt_legacy_search",
        toolCallId: "legacy_search",
        displayName: "Search web",
        kind: "search",
      }),
      event({ type: "thread.completed", eventId: "evt_legacy_complete", outcome: "completed" }),
    ]);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: fake.store });

    const events = [];
    for await (const candidate of adapter.start(input())) events.push(candidate);

    expect(events).toEqual([
      { type: "state.updated", state: { conversationId: "thread_native" } },
      expect.objectContaining({ type: "tool.progress", toolCallId: "legacy_tool" }),
      expect.objectContaining({ type: "agent.activity", activityId: "legacy_agent", kind: "delegation" }),
      expect.objectContaining({ type: "agent.activity", activityId: "legacy_search", kind: "web_search" }),
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
