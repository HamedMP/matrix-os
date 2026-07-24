// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";
import { agentThreadAbortSupported } from "../../desktop/src/renderer/src/features/coding-agents/abort-thread";
import { useCodingAgentMessageQueue } from "../../desktop/src/renderer/src/features/coding-agents/message-queue-store";
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

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("AgentConversationView abort control", () => {
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
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("reports no abort support when the preload bridge is missing", () => {
    Object.defineProperty(window, "operator", { configurable: true, value: undefined });
    expect(agentThreadAbortSupported()).toBe(false);
  });

  it("hides the stop button while the agent runs when the bridge is missing", () => {
    Object.defineProperty(window, "operator", { configurable: true, value: undefined });
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("shows the stop button while the agent runs and invokes the abort channel", () => {
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    const stop = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(stop);

    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:abort-thread", {
      threadId: "thread_alpha",
    });
  });

  it("keeps the send button on an idle thread even when abort is supported", () => {
    render(
      <AgentConversationView status="ready" snapshot={snapshot([], { status: "completed" })} error={null} canSendTurns />,
    );

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("swallows a rejected abort call with a warning instead of crashing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(() => Promise.reject(new Error("provider exploded"))),
        on: vi.fn(() => () => undefined),
      },
    });
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/provider exploded/);
  });
});
