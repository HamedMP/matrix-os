// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";
import {
  toolCallDurationLabel,
  toolKindLabel,
} from "../../desktop/src/renderer/src/features/coding-agents/tool-call-detail";
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

function toolEvents({
  id,
  displayName,
  kind,
  outcome,
  outputCount = 0,
  truncated = false,
  startedAt = "2026-07-15T00:03:00.000Z",
  completedAt = "2026-07-15T00:03:30.000Z",
}: {
  id: string;
  displayName: string;
  kind: string;
  outcome: "success" | "failed" | "cancelled" | null;
  outputCount?: number;
  truncated?: boolean;
  startedAt?: string;
  completedAt?: string;
}): AgentThreadEvent[] {
  const events: AgentThreadEvent[] = [
    {
      type: "tool.started",
      eventId: `evt_${id}_start`,
      threadId: "thread_alpha",
      occurredAt: startedAt,
      toolCallId: id,
      displayName,
      kind,
    } as AgentThreadEvent,
  ];
  for (let index = 0; index < outputCount; index += 1) {
    events.push({
      type: "tool.output",
      eventId: `evt_${id}_output_${index}`,
      threadId: "thread_alpha",
      occurredAt: startedAt,
      toolCallId: id,
      text: `bounded output chunk ${index}`,
      ...(truncated && index === outputCount - 1 ? { truncated: true } : {}),
    } as AgentThreadEvent);
  }
  if (outcome) {
    events.push({
      type: "tool.completed",
      eventId: `evt_${id}_done`,
      threadId: "thread_alpha",
      occurredAt: completedAt,
      toolCallId: id,
      outcome,
    } as AgentThreadEvent);
  }
  return events;
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("tool-call detail helpers", () => {
  it("labels durations under a second in milliseconds", () => {
    const events = toolEvents({
      id: "tc",
      displayName: "Shell command",
      kind: "command",
      outcome: "success",
      startedAt: "2026-07-15T00:03:00.000Z",
      completedAt: "2026-07-15T00:03:00.400Z",
    });
    expect(toolCallDurationLabel(events)).toBe("400ms");
  });

  it("labels multi-second and multi-minute durations", () => {
    expect(
      toolCallDurationLabel(
        toolEvents({
          id: "tc",
          displayName: "Shell command",
          kind: "command",
          outcome: "success",
          startedAt: "2026-07-15T00:03:00.000Z",
          completedAt: "2026-07-15T00:03:30.000Z",
        }),
      ),
    ).toBe("30s");
    expect(
      toolCallDurationLabel(
        toolEvents({
          id: "tc",
          displayName: "Shell command",
          kind: "command",
          outcome: "success",
          startedAt: "2026-07-15T00:03:00.000Z",
          completedAt: "2026-07-15T00:05:05.000Z",
        }),
      ),
    ).toBe("2m 5s");
  });

  it("returns no duration for unfinished or unparseable calls", () => {
    expect(toolCallDurationLabel(toolEvents({ id: "tc", displayName: "Shell command", kind: "command", outcome: null }))).toBeNull();
    const bad = toolEvents({
      id: "tc",
      displayName: "Shell command",
      kind: "command",
      outcome: "success",
      startedAt: "not-a-date",
      completedAt: "also-not-a-date",
    });
    expect(toolCallDurationLabel(bad)).toBeNull();
  });

  it("humanizes tool kinds", () => {
    expect(toolKindLabel("command")).toBe("Command");
    expect(toolKindLabel("file_change")).toBe("File change");
    expect(toolKindLabel("web-search")).toBe("Web search");
    expect(toolKindLabel(undefined)).toBe("Tool");
  });
});

describe("AgentConversationView tool-call detail", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    useCodingAgentMessageQueue.setState({ queues: {} });
    useCodingAgentWorkspace.setState({ turnStatus: "idle", turnError: null, turnThreadId: null });
  });

  afterEach(cleanup);

  it("shows kind, duration, outcome, and output stats when a completed chip expands", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([
          ...toolEvents({ id: "tc_1", displayName: "Run checks", kind: "command", outcome: "success", outputCount: 2, truncated: true }),
        ])}
        error={null}
        canSendTurns
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Tool call Run checks" }));

    expect(screen.getByText("Command")).toBeTruthy();
    expect(screen.getByText("30s")).toBeTruthy();
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(screen.getByText("2 output chunks")).toBeTruthy();
    // The bounded status sentence and truncation note stay as they were.
    expect(screen.getAllByText(/Run checks completed successfully/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Output was truncated for display/)).toBeTruthy();
    // Raw payloads still never render.
    expect(screen.queryByText(/bounded output chunk/)).toBeNull();
  });

  it("marks a running tool without a duration", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([...toolEvents({ id: "tc_2", displayName: "Edit file", kind: "file_change", outcome: null })])}
        error={null}
        canSendTurns
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Tool call Edit file" }));

    expect(screen.getByText("File change")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("No captured output")).toBeTruthy();
  });

  it("marks a failed tool", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([...toolEvents({ id: "tc_3", displayName: "Web search", kind: "web", outcome: "failed", outputCount: 1 })])}
        error={null}
        canSendTurns
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Tool call Web search" }));

    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("1 output chunk")).toBeTruthy();
  });
});
