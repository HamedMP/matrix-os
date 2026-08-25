// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { mergeLiveThreadEvent } from "../../desktop/src/renderer/src/stores/coding-agent/thread-model";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

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

function toolEvents(id: string, displayName: string, outcome: "success" | "failed" | "cancelled" | null): AgentThreadEvent[] {
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

function userMessage(id: string, text: string, second: number): AgentThreadEvent {
  return {
    type: "user.message",
    eventId: `evt_user_${id}`,
    threadId: "thread_alpha",
    occurredAt: `2026-07-15T00:00:${String(second).padStart(2, "0")}.000Z`,
    messageId: id,
    text,
  } as AgentThreadEvent;
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
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: null,
    });
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

  it("never auto-fetches remote images from assistant markdown", () => {
    const text = "Look at this: ![build badge](https://tracker.example/pixel.png) done.";
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([delta("msg_1", text, 1), completedEvent("msg_1")])}
        error={null}
        canSendTurns
      />,
    );

    expect(document.querySelector("img")).toBeNull();
    // The image degrades to inert text so the user still sees what was sent.
    expect(screen.getByText(/build badge/)).toBeTruthy();
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

  it("preserves whitespace, Markdown code boundaries, and multibyte text across same-timestamp live chunks", () => {
    const occurredAt = "2026-07-15T00:01:00.000Z";
    const chunks = [
      { eventId: "evt_z", text: "# Result\n\n你好" },
      { eventId: "evt_y", text: " 👋\n\n```ts\n" },
      { eventId: "evt_x", text: "const greeting = \"你好 👋\";\n" },
      { eventId: "evt_w", text: "```\n\nDone." },
    ];
    const live = chunks.reduce(
      (current, chunk) => mergeLiveThreadEvent(current, {
        type: "assistant.text.delta",
        eventId: chunk.eventId,
        threadId: "thread_alpha",
        occurredAt,
        messageId: "msg_multibyte",
        delta: chunk.text,
      }),
      snapshot([]),
    );

    render(
      <AgentConversationView status="ready" snapshot={live} error={null} canSendTurns />,
    );

    expect(screen.getByRole("heading", { name: "Result" })).toBeTruthy();
    expect(screen.getByText("你好 👋")).toBeTruthy();
    expect(document.querySelector("pre code")?.textContent).toContain('const greeting = "你好 👋";');
    expect(screen.getByText("Done.")).toBeTruthy();
  });

  it("does not let a late delta for completed A mutate A after turn B starts", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([
          delta("msg_a", "Stable answer.", 1),
          completedEvent("msg_a"),
          {
            type: "turn.accepted",
            eventId: "evt_turn_b",
            threadId: "thread_alpha",
            occurredAt: "2026-07-15T00:03:00.000Z",
            turnId: "turn_b",
            clientRequestId: "req_b",
            acceptedAt: "2026-07-15T00:03:00.000Z",
          },
          {
            type: "user.message",
            eventId: "evt_user_b",
            threadId: "thread_alpha",
            occurredAt: "2026-07-15T00:03:00.000Z",
            messageId: "msg_user_b",
            text: "Follow-up B",
            clientRequestId: "req_b",
            turnId: "turn_b",
          },
          {
            type: "assistant.text.delta",
            eventId: "evt_late_a",
            threadId: "thread_alpha",
            occurredAt: "2026-07-15T00:04:00.000Z",
            messageId: "msg_a",
            delta: " STALE",
          },
        ])}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByText("Stable answer.")).toBeTruthy();
    expect(screen.queryByText(/STALE/)).toBeNull();
    expect(screen.getByText("Follow-up B")).toBeTruthy();
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

  it("keeps the active turn and latest tool-call tail visible", () => {
    const events = [
      userMessage("msg_user_active", "Inspect the project", 1),
      ...Array.from({ length: 7 }, (_, index) => toolEvents(`tc_${index}`, `Tool ${index}`, "success")).flat(),
    ];
    render(
      <AgentConversationView status="ready" snapshot={snapshot(events)} error={null} canSendTurns />,
    );

    expect(document.querySelectorAll('[data-slot="agent-turn"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "+4 earlier tool calls" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tool call Tool 0" })).toBeNull();
    expect(screen.getByRole("button", { name: "Tool call Tool 6" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+4 earlier tool calls" }));
    expect(screen.getByRole("button", { name: "Tool call Tool 0" })).toBeTruthy();
  });

  it("collapses a settled turn's tool activity behind one truthful summary", () => {
    const events = [
      userMessage("msg_user_settled", "Run the checks", 1),
      ...Array.from({ length: 7 }, (_, index) => toolEvents(`settled_${index}`, `Check ${index}`, "success")).flat(),
      delta("msg_result", "All checks passed.", 40),
      completedEvent("msg_result"),
    ];
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot(events, { status: "completed" })}
        error={null}
        canSendTurns
      />,
    );

    const turn = document.querySelector('[data-slot="agent-turn"]');
    expect(turn).not.toBeNull();
    expect(turn?.textContent).toContain("All checks passed.");
    const summary = screen.getByRole("button", { name: "7 tool calls, completed" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Tool call Check 0" })).toBeNull();

    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Tool call Check 0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tool call Check 6" })).toBeTruthy();
  });

  it("keeps message actions on the terminal result without spacing out commentary", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([
          userMessage("msg_user_meta", "Inspect the transcript", 1),
          delta("msg_commentary", "I’ll inspect the renderer first.", 2),
          completedEvent("msg_commentary"),
          ...toolEvents("tc_meta", "Read renderer", "success"),
          delta("msg_result", "The renderer is verified.", 20),
          completedEvent("msg_result"),
        ], { status: "completed" })}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getAllByRole("button", { name: "Copy assistant message" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Copy your message" })).toBeTruthy();
  });

  it("keeps multiple turn sections in received chronology", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([
          userMessage("msg_user_1", "First request", 1),
          delta("msg_first_result", "First result", 2),
          completedEvent("msg_first_result"),
          userMessage("msg_user_2", "Second request", 3),
          delta("msg_second_result", "Second result", 4),
          completedEvent("msg_second_result"),
        ], { status: "completed" })}
        error={null}
        canSendTurns
      />,
    );

    const turns = Array.from(document.querySelectorAll('[data-slot="agent-turn"]'));
    expect(turns).toHaveLength(2);
    expect(turns[0]?.textContent).toContain("First request");
    expect(turns[0]?.textContent).toContain("First result");
    expect(turns[1]?.textContent).toContain("Second request");
    expect(turns[1]?.textContent).toContain("Second result");
  });

  it("renders a cancelled tool result as cancelled instead of completed", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([
          userMessage("msg_user_cancelled", "Stop the check", 1),
          ...toolEvents("tc_cancelled", "Cancelled check", "cancelled"),
        ], { status: "completed" })}
        error={null}
        canSendTurns
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "1 tool call, cancelled" }));
    expect(screen.getByLabelText("Cancelled")).toBeTruthy();
    expect(screen.queryByLabelText("Completed")).toBeNull();
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

    const input = screen.getByLabelText("Message conversation");
    expect(input.getAttribute("data-max-length")).toBe("24000");
  });

  it("uploads dropped files and sends a follow-up with existing structured refs", async () => {
    const sendThreadMessage = vi.fn().mockResolvedValue(true);
    const putBytes = vi.fn(async (path: string, file: File) => ({
      ok: true,
      path: decodeURIComponent(path.split("path=")[1] ?? ""),
      size: file.size,
    }));
    useCodingAgentWorkspace.setState({ sendThreadMessage });
    useConnection.setState({ api: { putBytes } as never });
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([], { status: "completed" })}
        error={null}
        canSendTurns
      />,
    );

    const pane = screen.getByRole("region", { name: "Conversation Fix settings route" });
    fireEvent.drop(pane, {
      dataTransfer: { files: [new File(["context"], "context.txt", { type: "text/plain" })] },
    });
    const input = screen.getByLabelText("Message conversation");
    await setSharedComposerText(input, "Continue with this context");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sendThreadMessage).toHaveBeenCalledWith({
      threadId: "thread_alpha",
      message: "Continue with this context",
      attachments: [expect.objectContaining({
        id: expect.stringMatching(/^desktop_upload_[A-Za-z0-9]+$/),
        kind: "structured_ref",
        label: "context.txt",
        path: expect.stringMatching(/^temporary\/desktop-chat\/[A-Za-z0-9]+-context\.txt$/),
      })],
    }));
    expect(screen.queryByRole("button", { name: "Remove context.txt" })).toBeNull();
  });

  it("clears an unsent draft when switching threads", async () => {
    const view = render(
      <AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />,
    );
    const input = screen.getByLabelText("Message conversation");
    await setSharedComposerText(input, "draft for thread alpha");
    expect(input.textContent).toBe("draft for thread alpha");

    view.rerender(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([], { id: "thread_beta", title: "Other thread" })}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByLabelText("Message conversation").textContent).toBe("");
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

  it("renders system status events as compact timeline rows, not cards", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([
          {
            type: "thread.created",
            eventId: "evt_created_1",
            threadId: "thread_alpha",
            occurredAt: "2026-07-15T00:00:05.000Z",
            thread: { id: "thread_alpha", title: "Fix settings route" },
          } as unknown as AgentThreadEvent,
          {
            type: "terminal.bound",
            eventId: "evt_terminal_1",
            threadId: "thread_alpha",
            occurredAt: "2026-07-15T00:00:10.000Z",
            terminalSessionId: "term_1",
          } as AgentThreadEvent,
          {
            type: "thread.completed",
            eventId: "evt_completed_thread",
            threadId: "thread_alpha",
            occurredAt: "2026-07-15T00:04:00.000Z",
            outcome: "success",
          } as AgentThreadEvent,
        ], { status: "completed" })}
        error={null}
        canSendTurns
      />,
    );

    // Same bounded copy as before, on a single compact row per event…
    const rows = document.querySelectorAll('[data-slot="system-event-row"]');
    expect(rows).toHaveLength(3);
    const createdRow = screen.getByText("Thread created").closest('[data-slot="system-event-row"]');
    expect(createdRow).not.toBeNull();
    expect(createdRow!.textContent).toContain("Fix settings route");
    expect(screen.getByText("Terminal bound")).toBeTruthy();
    expect(screen.getByText("Thread completed")).toBeTruthy();
    // …with a leading glyph, a right-aligned time, and no card anatomy.
    expect(createdRow!.querySelector("svg")).not.toBeNull();
    expect(createdRow!.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(createdRow!.className).not.toContain("border");
    expect(createdRow!.className).not.toContain("rounded-lg");
    expect(createdRow!.className).not.toContain("shadow");
  });

  it("keeps the review-ready event on its actionable card", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={snapshot([
          {
            type: "review.ready",
            eventId: "evt_review_1",
            threadId: "thread_alpha",
            occurredAt: "2026-07-15T00:03:00.000Z",
            reviewId: "rev_1",
            summary: { changedFileCount: 2, additions: 12, deletions: 4, partial: false },
          } as AgentThreadEvent,
        ])}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByText("Review ready")).toBeTruthy();
    expect(screen.getByText("2 files changed, +12 -4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open review from thread" })).toBeTruthy();
    expect(document.querySelector('[data-slot="system-event-row"]')).toBeNull();
  });
});
