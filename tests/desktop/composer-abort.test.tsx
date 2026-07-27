// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";
import { agentThreadAbortSupported } from "../../desktop/src/renderer/src/features/coding-agents/abort-thread";
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
    delete (window as { operator?: unknown }).operator;
  });

  // Abort rides the same typed operator bridge as every other runtime call, so
  // support tracks the preload being present at all.
  function mockOperator(invoke = vi.fn(async () => snapshot([], { status: "aborted" }))) {
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    return invoke;
  }

  it("reports no abort support when the preload bridge is absent", () => {
    delete (window as { operator?: unknown }).operator;
    expect(agentThreadAbortSupported()).toBe(false);
  });

  it("reports abort support when the typed operator bridge is present", () => {
    mockOperator();
    expect(agentThreadAbortSupported()).toBe(true);
  });

  it("hides the stop button while the agent runs when abort is unsupported", () => {
    delete (window as { operator?: unknown }).operator;
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("aborts through the typed runtime channel when Stop is clicked", async () => {
    const invoke = mockOperator();
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "runtime:abort-thread",
        expect.objectContaining({ threadId: "thread_alpha" }),
      ),
    );
  });

  it("applies the authoritative aborted snapshot so the composer unblocks", async () => {
    // Mirrors a dropped event stream: nothing else will tell the conversation
    // the run ended, so the abort response has to settle it.
    mockOperator();
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await vi.waitFor(() =>
      expect(useCodingAgentWorkspace.getState().threadSnapshot?.thread.status).toBe("aborted"),
    );
  });

  it("keeps the send button on an idle thread even when abort is supported", () => {
    mockOperator();
    render(
      <AgentConversationView status="ready" snapshot={snapshot([], { status: "completed" })} error={null} canSendTurns />,
    );

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("surfaces generic copy when abort fails, and keeps provider text out of the UI", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockOperator(vi.fn(() => Promise.reject(new Error("provider exploded"))));
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    // The user must be told the stop did not take effect -- previously the
    // failure was swallowed and the busy UI looked identical to success.
    await vi.waitFor(() =>
      expect(useCodingAgentWorkspace.getState().turnError).toMatch(/could not stop/i),
    );
    // Generic copy only: the raw provider message never reaches the UI.
    expect(useCodingAgentWorkspace.getState().turnError).not.toMatch(/provider exploded/);
    // The console keeps the real message for support triage.
    expect(warn).toHaveBeenCalled();
  });
});
