// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";
import {
  deriveTurnSummaries,
  formatTurnDuration,
} from "../../desktop/src/renderer/src/features/coding-agents/turn-summary";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

function userMessage(id: string, occurredAt: string): AgentThreadEvent {
  return {
    type: "user.message",
    eventId: `evt_user_${id}`,
    threadId: "thread_alpha",
    occurredAt,
    messageId: `msg_user_${id}`,
    text: `do thing ${id}`,
  } as AgentThreadEvent;
}

function assistantDelta(messageId: string, delta: string, occurredAt: string): AgentThreadEvent {
  return {
    type: "assistant.text.delta",
    eventId: `evt_delta_${messageId}`,
    threadId: "thread_alpha",
    occurredAt,
    messageId,
    delta,
  } as AgentThreadEvent;
}

function assistantCompleted(messageId: string, occurredAt: string): AgentThreadEvent {
  return {
    type: "assistant.text.completed",
    eventId: `evt_completed_${messageId}`,
    threadId: "thread_alpha",
    occurredAt,
    messageId,
  } as AgentThreadEvent;
}

function toolStarted(id: string, displayName: string, occurredAt: string): AgentThreadEvent {
  return {
    type: "tool.started",
    eventId: `evt_tool_${id}_start`,
    threadId: "thread_alpha",
    occurredAt,
    toolCallId: id,
    displayName,
  } as AgentThreadEvent;
}

function toolCompleted(id: string, occurredAt: string): AgentThreadEvent {
  return {
    type: "tool.completed",
    eventId: `evt_tool_${id}_done`,
    threadId: "thread_alpha",
    occurredAt,
    toolCallId: id,
    outcome: "success",
  } as AgentThreadEvent;
}

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

describe("formatTurnDuration", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatTurnDuration(12_000)).toBe("12s");
    expect(formatTurnDuration(12_400)).toBe("12s");
  });

  it("formats longer durations as minutes and seconds", () => {
    expect(formatTurnDuration(335_000)).toBe("5m 35s");
  });

  it("omits zero seconds for exact minutes", () => {
    expect(formatTurnDuration(300_000)).toBe("5m");
  });

  it("rounds sub-second durations up to one second", () => {
    expect(formatTurnDuration(400)).toBe("1s");
  });
});

describe("deriveTurnSummaries", () => {
  it("derives a summary from the first and last event of a finished turn", () => {
    const events = [
      userMessage("1", "2026-07-15T00:00:00.000Z"),
      assistantDelta("msg_a1", "working on it", "2026-07-15T00:00:05.000Z"),
      assistantCompleted("msg_a1", "2026-07-15T00:00:17.000Z"),
    ];

    expect(deriveTurnSummaries(events, false)).toEqual([
      { endOrder: 2, label: "Worked for 12s" },
    ]);
  });

  it("closes a turn when the next user message arrives even while the thread runs", () => {
    const events = [
      userMessage("1", "2026-07-15T00:00:00.000Z"),
      assistantDelta("msg_a1", "first answer", "2026-07-15T00:00:05.000Z"),
      assistantCompleted("msg_a1", "2026-07-15T00:00:17.000Z"),
      userMessage("2", "2026-07-15T00:01:00.000Z"),
      assistantDelta("msg_a2", "second answer", "2026-07-15T00:01:05.000Z"),
    ];

    // The live second turn is excluded; the finished first turn is summarized.
    expect(deriveTurnSummaries(events, true)).toEqual([
      { endOrder: 2, label: "Worked for 12s" },
    ]);
  });

  it("excludes the live turn while the thread is running", () => {
    const events = [
      userMessage("1", "2026-07-15T00:00:00.000Z"),
      assistantDelta("msg_a1", "still going", "2026-07-15T00:00:05.000Z"),
    ];

    expect(deriveTurnSummaries(events, true)).toEqual([]);
  });

  it("skips turns whose timestamps cannot be parsed", () => {
    const events = [
      userMessage("1", "2026-07-15T00:00:00.000Z"),
      assistantDelta("msg_a1", "no clock", "not-a-date"),
      assistantCompleted("msg_a1", "2026-07-15T00:00:17.000Z"),
    ];

    expect(deriveTurnSummaries(events, false)).toEqual([]);
  });

  it("skips a single-event turn with no measurable duration", () => {
    const events = [
      userMessage("1", "2026-07-15T00:00:00.000Z"),
      {
        type: "turn.accepted",
        eventId: "evt_turn_1",
        threadId: "thread_alpha",
        occurredAt: "2026-07-15T00:00:01.000Z",
        turnId: "turn_1",
        clientRequestId: "req_1",
        acceptedAt: "2026-07-15T00:00:01.000Z",
      } as AgentThreadEvent,
    ];

    expect(deriveTurnSummaries(events, false)).toEqual([]);
  });

  it("ignores events that arrive before the first user message", () => {
    const events = [
      {
        type: "thread.status",
        eventId: "evt_status_1",
        threadId: "thread_alpha",
        occurredAt: "2026-07-15T00:00:00.000Z",
        status: "starting",
      } as AgentThreadEvent,
      userMessage("1", "2026-07-15T00:00:05.000Z"),
      assistantDelta("msg_a1", "answer", "2026-07-15T00:00:06.000Z"),
      assistantCompleted("msg_a1", "2026-07-15T00:00:08.000Z"),
    ];

    expect(deriveTurnSummaries(events, false)).toEqual([
      { endOrder: 3, label: "Worked for 2s" },
    ]);
  });
});

describe("AgentConversationView worked-for rows", () => {
  beforeEach(() => {
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    useCodingAgentWorkspace.setState({ turnStatus: "idle", turnError: null, turnThreadId: null });
  });

  afterEach(cleanup);

  it("renders a Worked-for row after a finished turn", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot(
          [
            userMessage("1", "2026-07-15T00:00:00.000Z"),
            assistantDelta("msg_a1", "All done.", "2026-07-15T00:00:05.000Z"),
            assistantCompleted("msg_a1", "2026-07-15T00:00:17.000Z"),
          ],
          { status: "completed" },
        )}
        error={null}
        canSendTurns
      />,
    );

    const row = screen.getByText("Worked for 12s");
    expect(row).toBeTruthy();
    // Non-interactive summary: the row never collapses or expands on click.
    expect(row.closest("button")).toBeNull();
    expect(screen.getByText("All done.")).toBeTruthy();
  });

  it("keeps the Working row for the live turn instead of a summary", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([userMessage("1", "2026-07-15T00:00:00.000Z")])}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByRole("status", { name: "Agent is working" })).toBeTruthy();
    expect(screen.queryByText(/Worked for/)).toBeNull();
  });

  it("summarizes earlier turns while a later turn is still running", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([
          userMessage("1", "2026-07-15T00:00:00.000Z"),
          assistantDelta("msg_a1", "first answer", "2026-07-15T00:00:05.000Z"),
          assistantCompleted("msg_a1", "2026-07-15T00:00:17.000Z"),
          userMessage("2", "2026-07-15T00:01:00.000Z"),
          assistantDelta("msg_a2", "second answer streaming", "2026-07-15T00:01:10.000Z"),
        ])}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getAllByText("Worked for 12s")).toHaveLength(1);
  });

  it("renders the summary after a turn that ends on a tool run", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot(
          [
            userMessage("1", "2026-07-15T00:00:00.000Z"),
            toolStarted("tc_1", "Run checks", "2026-07-15T00:00:05.000Z"),
            toolCompleted("tc_1", "2026-07-15T00:00:41.000Z"),
          ],
          { status: "completed" },
        )}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByText("Worked for 36s")).toBeTruthy();
  });

  it("renders one summary per finished turn in a multi-turn thread", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot(
          [
            userMessage("1", "2026-07-15T00:00:00.000Z"),
            assistantDelta("msg_a1", "first", "2026-07-15T00:00:05.000Z"),
            assistantCompleted("msg_a1", "2026-07-15T00:00:17.000Z"),
            userMessage("2", "2026-07-15T00:01:00.000Z"),
            assistantDelta("msg_a2", "second", "2026-07-15T00:01:05.000Z"),
            assistantCompleted("msg_a2", "2026-07-15T00:06:40.000Z"),
          ],
          { status: "completed" },
        )}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByText("Worked for 12s")).toBeTruthy();
    expect(screen.getByText("Worked for 5m 35s")).toBeTruthy();
  });
});
