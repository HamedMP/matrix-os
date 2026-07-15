// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function delta(messageId: string, text: string, index: number): AgentThreadEvent {
  return {
    type: "assistant.text.delta",
    eventId: `evt_delta_${messageId}_${index}`,
    threadId: "thread_alpha",
    occurredAt: `2026-07-15T00:01:${String(index).padStart(2, "0")}.000Z`,
    messageId,
    delta: text,
  } as AgentThreadEvent;
}

function completedEvent(messageId: string): AgentThreadEvent {
  return {
    type: "assistant.text.completed",
    eventId: `evt_done_${messageId}`,
    threadId: "thread_alpha",
    occurredAt: "2026-07-15T00:02:00.000Z",
    messageId,
  } as AgentThreadEvent;
}

function toolEvents(id: string, displayName: string, outcome: "success" | "failed" | null): AgentThreadEvent[] {
  const events: AgentThreadEvent[] = [
    {
      type: "tool.started",
      eventId: `evt_tool_${id}_start`,
      threadId: "thread_alpha",
      occurredAt: "2026-07-15T00:03:00.000Z",
      toolCallId: id,
      displayName,
    } as AgentThreadEvent,
  ];
  if (outcome) {
    events.push({
      type: "tool.completed",
      eventId: `evt_tool_${id}_done`,
      threadId: "thread_alpha",
      occurredAt: "2026-07-15T00:03:30.000Z",
      toolCallId: id,
      outcome,
    } as AgentThreadEvent);
  }
  return events;
}

describe("AgentConversationView transcript", () => {
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

  it("renders the full assistant message as markdown, not a truncated preview", () => {
    const paragraph = "The migration needs three steps. ".repeat(30);
    const text = `# Plan\n\n${paragraph}\n\n- first\n- second\n\n\`\`\`ts\nconst limit = 240;\n\`\`\``;
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([delta("msg_1", text, 1), completedEvent("msg_1")])}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByText("first")).toBeTruthy();
    expect(document.querySelector("pre code")?.textContent).toContain("const limit = 240;");
    // Well beyond the old 240-char display cap.
    expect((screen.getByText(/The migration needs three steps/).textContent ?? "").length).toBeGreaterThan(500);
    expect(screen.queryByText(/text updates received/)).toBeNull();
  });

  it("keeps technical vocabulary visible while masking real credentials", () => {
    const text = "Set the token limit in /Users/dev/app.ts, then export API_KEY=sk-proj-Abc123_def456ghi789 before localhost testing.";
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([delta("msg_1", text, 1), completedEvent("msg_1")])}
        error={null}
        canSendTurns
      />,
    );

    const body = screen.getByText(/Set the token limit/).textContent ?? "";
    expect(body).toContain("/Users/dev/app.ts");
    expect(body).toContain("localhost");
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("sk-proj-Abc123_def456ghi789");
  });

  it("redacts credentials before applying the display truncation slice", () => {
    // The slice boundary lands inside the password value: the prefix falls
    // outside the retained tail, so slicing before redaction would leak the
    // remaining value characters. Redaction must run on the full text first.
    const secret = "h".repeat(200);
    const text = `password=${secret}${"y".repeat(63_900)}`;
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([delta("msg_1", text, 1), completedEvent("msg_1")])}
        error={null}
        canSendTurns
      />,
    );

    expect(document.body.textContent).not.toContain("h".repeat(50));
  });

  it("tells a read-only computer there are no messages instead of inviting one", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([], { status: "completed" })}
        error={null}
        canSendTurns={false}
      />,
    );

    expect(screen.getByText("No messages yet.")).toBeTruthy();
    expect(screen.queryByText("Send a message to start the conversation.")).toBeNull();
  });

  it("joins streamed deltas for one message in order", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([delta("msg_1", "Reading the fail", 1), delta("msg_1", "ing test now.", 2)])}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByText("Reading the failing test now.")).toBeTruthy();
  });

  it("collapses long user messages behind a show-more toggle", () => {
    const long = Array.from({ length: 14 }, (_, index) => `line ${index}`).join("\n");
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([
          {
            type: "user.message",
            eventId: "evt_user_1",
            threadId: "thread_alpha",
            occurredAt: "2026-07-15T00:00:30.000Z",
            messageId: "msg_user_1",
            text: long,
          } as AgentThreadEvent,
        ])}
        error={null}
        canSendTurns
      />,
    );

    const toggle = screen.getByRole("button", { name: "Show full message" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("renders tool calls as one-line chips with a status glyph and bounded expansion", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([...toolEvents("tc_1", "Shell command", "failed")])}
        error={null}
        canSendTurns
      />,
    );

    const chip = screen.getByRole("button", { name: "Tool call Shell command" });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText(/completed with errors/).length).toBeGreaterThan(0);
  });

  it("collapses long tool runs behind an earlier-calls toggle", () => {
    const events = Array.from({ length: 7 }, (_, index) => toolEvents(`tc_${index}`, `Tool ${index}`, "success")).flat();
    render(
      <AgentConversationView status="ready" snapshot={snapshot(events)} error={null} canSendTurns />,
    );

    expect(screen.getByRole("button", { name: "+4 earlier tool calls" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tool call Tool 0" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+4 earlier tool calls" }));
    expect(screen.getByRole("button", { name: "Tool call Tool 0" })).toBeTruthy();
  });

  it("shows a working indicator while the thread runs without streaming text", () => {
    render(
      <AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />,
    );

    expect(screen.getByRole("status", { name: "Agent is working" })).toBeTruthy();
  });

  it("caps the composer draft at the turn schema limit", () => {
    render(
      <AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />,
    );

    const input = screen.getByLabelText("Message conversation") as HTMLTextAreaElement;
    expect(input.maxLength).toBe(24_000);
  });

  it("clears an unsent draft when switching threads", () => {
    const view = render(
      <AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />,
    );
    const input = screen.getByLabelText("Message conversation") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "draft for thread alpha" } });
    expect(input.value).toBe("draft for thread alpha");

    view.rerender(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([], { id: "thread_beta", title: "Other thread" })}
        error={null}
        canSendTurns
      />,
    );

    expect((screen.getByLabelText("Message conversation") as HTMLTextAreaElement).value).toBe("");
  });

  it("resets the transcript scroller when switching threads", () => {
    const view = render(
      <AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />,
    );
    const scroller = () => document.querySelector(".relative.min-h-0.flex-1 > .h-full");
    const before = scroller();
    expect(before).not.toBeNull();

    view.rerender(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([], { id: "thread_beta", title: "Other thread" })}
        error={null}
        canSendTurns
      />,
    );

    // A keyed remount replaces the scroll container so thread B starts pinned
    // to the latest message instead of inheriting thread A's offset.
    expect(scroller()).not.toBe(before);
  });

  it("invites the first message on an idle empty thread", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([], { status: "completed" })}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByText("Send a message to start the conversation.")).toBeTruthy();
  });
});
