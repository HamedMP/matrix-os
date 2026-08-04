// @vitest-environment jsdom

// SPEC 105 FR-027/FR-101: at most one normal turn may be active per thread, and
// a follow-up aimed at a busy conversation must return a safe recoverable
// conflict. Clients must not invent a local queue, so these tests pin the
// composer to direct-send semantics with no client-side queueing.

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";
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

function mockOperator(createTurn?: () => unknown) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runtime:create-turn") {
      if (createTurn) return createTurn();
      return {
        ok: true,
        response: {
          threadId: (payload as { threadId: string }).threadId,
          turnId: "turn_direct_1",
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

describe("AgentConversationView composer busy conflict", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
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

  it("sends directly instead of queueing while the agent is running", async () => {
    const { invoke } = mockOperator();
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    typeAndEnter("Follow-up while busy");

    // The runtime owns the decision. The client does not withhold the message.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("runtime:create-turn", expect.objectContaining({ threadId: "thread_alpha" })),
    );
    expect(screen.queryByLabelText("Queued follow-ups")).toBeNull();
  });

  it("keeps the draft and surfaces the safe conflict when the runtime reports the thread busy", async () => {
    mockOperator(() => ({ ok: false, error: { code: "thread_busy" } }));
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    const input = typeAndEnter("Follow-up while busy");

    await waitFor(() => expect(screen.getByText(/already running/i)).toBeTruthy());
    // The draft survives so the message is never silently swallowed.
    expect(input.value).toBe("Follow-up while busy");
  });

  it("does not render a queued-follow-up strip in any state", async () => {
    mockOperator();
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    typeAndEnter("First");
    typeAndEnter("Second");

    await waitFor(() => expect(screen.queryByLabelText("Queued follow-ups")).toBeNull());
  });

  it("keeps the composer disabled while the thread waits for an approval", () => {
    const { invoke } = mockOperator();
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
    expect(invoke).not.toHaveBeenCalledWith("runtime:create-turn", expect.anything());
  });

  it("sends normally once the thread is idle", async () => {
    const { invoke } = mockOperator();
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([], { status: "completed" })}
        error={null}
        canSendTurns
      />,
    );

    const input = typeAndEnter("Idle follow-up");

    await waitFor(() => expect(input.value).toBe(""));
    expect(invoke).toHaveBeenCalledWith("runtime:create-turn", expect.objectContaining({ threadId: "thread_alpha" }));
  });
});
