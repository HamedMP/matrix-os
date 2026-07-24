// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";
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

function transcriptEvents(): AgentThreadEvent[] {
  return [
    {
      type: "user.message",
      eventId: "evt_user_1",
      threadId: "thread_alpha",
      occurredAt: "2026-07-15T00:00:00.000Z",
      messageId: "msg_user_1",
      text: "Fix the failing test",
    } as AgentThreadEvent,
    {
      type: "assistant.text.delta",
      eventId: "evt_delta_1",
      threadId: "thread_alpha",
      occurredAt: "2026-07-15T00:00:05.000Z",
      messageId: "msg_a1",
      delta: "The fix is in.",
    } as AgentThreadEvent,
    {
      type: "assistant.text.completed",
      eventId: "evt_completed_1",
      threadId: "thread_alpha",
      occurredAt: "2026-07-15T00:00:09.000Z",
      messageId: "msg_a1",
    } as AgentThreadEvent,
  ];
}

describe("AgentConversationView composer card presentation", () => {
  beforeEach(() => {
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    useCodingAgentMessageQueue.setState({ queues: {} });
    useCodingAgentWorkspace.setState({ turnStatus: "idle", turnError: null, turnThreadId: null });
  });

  afterEach(cleanup);

  it("centers the transcript column at the shared readable width", () => {
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    const content = document.querySelector('[data-slot="message-scroller-content"]');
    expect(content).not.toBeNull();
    expect(content!.className).toContain("max-w-[46rem]");
    expect(content!.className).toContain("mx-auto");
  });

  it("renders the composer as a centered floating card matching the transcript width", () => {
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    const composer = screen.getByLabelText("Message conversation").closest('[data-slot="conversation-composer"]');
    expect(composer).not.toBeNull();
    expect(composer!.className).toContain("max-w-[46rem]");
    expect(composer!.className).toContain("mx-auto");

    const card = composer!.querySelector(".prompt-card");
    expect(card).not.toBeNull();
    expect(card!.className).toContain("rounded-2xl");
    expect(card!.className).toContain("border");
  });

  it("keeps the queued strip directly above the composer card", () => {
    useCodingAgentMessageQueue.getState().enqueue("thread_alpha", "Queued follow-up");
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    const strip = screen.getByLabelText("Queued follow-ups");
    expect(strip.nextElementSibling?.className ?? "").toContain("prompt-card");
  });

  it.each(["completed", "failed", "aborted"] as const)(
    "keeps the transcript and composer available for %s threads",
    (status) => {
      render(
        <AgentConversationView
          status="ready"
          snapshot={snapshot(transcriptEvents(), { status })}
          error={null}
          canSendTurns
        />,
      );

      // Transcript stays readable…
      expect(screen.getByText("The fix is in.")).toBeTruthy();
      // …and follow-ups remain possible from terminal states.
      const composer = screen.getByLabelText("Message conversation") as HTMLTextAreaElement;
      expect(composer).toBeTruthy();
      expect(composer.disabled).toBe(false);
    },
  );
});
