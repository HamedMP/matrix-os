// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";
import {
  MAX_QUEUED_MESSAGES_PER_THREAD,
  useCodingAgentMessageQueue,
} from "../../desktop/src/renderer/src/features/coding-agents/message-queue-store";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

function snapshot(events: AgentThreadEvent[], threadOverrides: Record<string, unknown> = {}): AgentThreadSnapshot {
  return {
    thread: {
      id: "thread_alpha",
      providerId: "codex",
      title: "Fix settings route",
      status: "running",
      attention: "none",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:04:00.000Z",
      ...threadOverrides,
    },
    events: { items: events, hasMore: false, limit: 200 },
  } as AgentThreadSnapshot;
}

function mockOperator() {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runtime:create-turn") {
      return {
        ok: true,
        response: {
          threadId: (payload as { threadId: string }).threadId,
          turnId: "turn_queued_1",
          status: "accepted",
          acceptedAt: "2026-07-15T00:05:00.000Z",
        },
      };
    }
    if (channel === "runtime:get-thread-snapshot") return snapshot([], { status: "completed" });
    if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") {
      return { ok: true };
    }
    throw new Error(`unexpected channel ${channel}`);
  });
  Object.defineProperty(window, "operator", {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
  return { invoke };
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function typeAndEnter(text: string) {
  const input = screen.getByLabelText("Message conversation") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
  return input;
}

describe("AgentConversationView composer queue", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    useCodingAgentMessageQueue.setState({ queues: {} });
    useCodingAgentWorkspace.setState({
      activeThreadId: "thread_alpha",
      threadSnapshot: snapshot([]),
      threadSnapshotStatus: "ready",
      turnStatus: "idle",
      turnError: null,
      turnRetry: null,
      turnThreadId: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the composer enabled while the agent runs and queues on Enter", async () => {
    const { invoke } = mockOperator();
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    const input = typeAndEnter("Queue this follow-up");

    await waitFor(() => expect(input.value).toBe(""));
    // Nothing hits the wire while the thread is busy: the message waits in
    // the queued strip above the composer.
    expect(invoke).not.toHaveBeenCalledWith("runtime:create-turn", expect.anything());
    expect(screen.getByText("Queue this follow-up")).toBeTruthy();
    expect(input.disabled).toBe(false);
    expect(useCodingAgentMessageQueue.getState().queues.thread_alpha).toHaveLength(1);
  });

  it("sends the next queued message automatically when the turn completes", async () => {
    const { invoke } = mockOperator();
    const view = render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);
    typeAndEnter("First queued");
    typeAndEnter("Second queued");
    await waitFor(() =>
      expect(useCodingAgentMessageQueue.getState().queues.thread_alpha.map((message) => message.text)).toEqual([
        "First queued",
        "Second queued",
      ]),
    );

    view.rerender(
      <AgentConversationView status="ready" snapshot={snapshot([], { status: "completed" })} error={null} canSendTurns />,
    );

    // FIFO drain: each accepted turn lets the next queued message send.
    await waitFor(() => {
      const sentMessages = invoke.mock.calls
        .filter((call) => call[0] === "runtime:create-turn")
        .map((call) => (call[1] as { message: string }).message);
      expect(sentMessages).toEqual(["First queued", "Second queued"]);
    });
    await waitFor(() =>
      expect(useCodingAgentMessageQueue.getState().queues.thread_alpha ?? []).toEqual([]),
    );
  });

  it("drains a queue that already exists when an idle thread opens", async () => {
    const { invoke } = mockOperator();
    useCodingAgentMessageQueue.getState().enqueue("thread_alpha", "leftover follow-up");
    render(
      <AgentConversationView status="ready" snapshot={snapshot([], { status: "completed" })} error={null} canSendTurns />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("runtime:create-turn", {
        threadId: "thread_alpha",
        message: "leftover follow-up",
        clientRequestId: expect.stringMatching(/^req_desktop_/),
      }),
    );
  });

  it("removes a queued message from the strip without sending it", async () => {
    const { invoke } = mockOperator();
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);
    typeAndEnter("First queued");
    typeAndEnter("Second queued");
    await waitFor(() => expect(useCodingAgentMessageQueue.getState().queues.thread_alpha).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Remove queued follow-up 1" }));

    expect(useCodingAgentMessageQueue.getState().queues.thread_alpha.map((message) => message.text)).toEqual([
      "Second queued",
    ]);
    expect(screen.queryByText("First queued")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("runtime:create-turn", expect.anything());
  });

  it("keeps the composer disabled while the thread waits for an approval instead of queueing", () => {
    mockOperator();
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([], { status: "waiting_for_approval", attention: "approval_required" })}
        error={null}
        canSendTurns
      />,
    );

    const input = screen.getByLabelText("Message conversation") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useCodingAgentMessageQueue.getState().queues.thread_alpha).toBeUndefined();
  });

  it("keeps the draft and says so when the queue is full", async () => {
    mockOperator();
    for (let index = 0; index < MAX_QUEUED_MESSAGES_PER_THREAD; index += 1) {
      useCodingAgentMessageQueue.getState().enqueue("thread_alpha", `queued ${index}`);
    }
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    const input = typeAndEnter("One message too many");

    await waitFor(() => expect(screen.getByText(/queue is full/i)).toBeTruthy());
    expect(input.value).toBe("One message too many");
    expect(useCodingAgentMessageQueue.getState().queues.thread_alpha).toHaveLength(MAX_QUEUED_MESSAGES_PER_THREAD);
  });

  it("requeues a drained message when the send is rejected", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:create-turn") {
        return {
          ok: false,
          error: { code: "thread_busy", safeMessage: "busy", retryable: true, recoveryActions: ["retry"] },
        };
      }
      if (channel === "runtime:get-thread-snapshot") return snapshot([]);
      if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") {
        return { ok: true };
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    useCodingAgentMessageQueue.getState().enqueue("thread_alpha", "retry me later");
    render(
      <AgentConversationView status="ready" snapshot={snapshot([], { status: "completed" })} error={null} canSendTurns />,
    );

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("runtime:create-turn", expect.anything()));
    // The rejected message returns to the front of the queue for the next
    // busy→idle cycle instead of being lost.
    await waitFor(() =>
      expect(useCodingAgentMessageQueue.getState().queues.thread_alpha.map((message) => message.text)).toEqual([
        "retry me later",
      ]),
    );
  });
});
