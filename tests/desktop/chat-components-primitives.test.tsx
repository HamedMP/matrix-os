// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "../../desktop/src/renderer/src/features/chat/elements/attachment";
import { Bubble, BubbleContent } from "../../desktop/src/renderer/src/features/chat/elements/bubble";
import { Marker, MarkerContent, MarkerIcon } from "../../desktop/src/renderer/src/features/chat/elements/marker";
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "../../desktop/src/renderer/src/features/chat/elements/message";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

describe("chat elements: Message + Bubble", () => {
  afterEach(cleanup);

  it("lays out an end-aligned user row with a secondary bubble", () => {
    render(
      <Message align="end">
        <MessageContent>
          <Bubble variant="secondary" align="end">
            <BubbleContent>ship it</BubbleContent>
          </Bubble>
          <MessageFooter>12:03</MessageFooter>
        </MessageContent>
      </Message>,
    );

    const row = document.querySelector("[data-slot='message']") as HTMLElement;
    expect(row.getAttribute("data-align")).toBe("end");
    const bubble = document.querySelector("[data-slot='bubble']") as HTMLElement;
    expect(bubble.getAttribute("data-variant")).toBe("secondary");
    expect(screen.getByText("ship it")).toBeTruthy();
    // Footer follows the message side on end-aligned rows.
    const footer = document.querySelector("[data-slot='message-footer']") as HTMLElement;
    expect(footer.className).toContain("group-data-[align=end]/message:justify-end");
  });

  it("lays out a start-aligned assistant row with header and ghost bubble", () => {
    render(
      <Message>
        <MessageContent>
          <MessageHeader>Hermes</MessageHeader>
          <Bubble variant="ghost">
            <BubbleContent>full width answer</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>,
    );

    const row = document.querySelector("[data-slot='message']") as HTMLElement;
    expect(row.getAttribute("data-align")).toBe("start");
    expect(document.querySelector("[data-slot='message-header']")?.textContent).toBe("Hermes");
    const bubble = document.querySelector("[data-slot='bubble']") as HTMLElement;
    expect(bubble.getAttribute("data-variant")).toBe("ghost");
  });
});

describe("chat elements: Marker", () => {
  afterEach(cleanup);

  it("renders a status marker with a shimmer text effect", () => {
    render(
      <Marker role="status">
        <MarkerIcon>
          <svg data-testid="icon" />
        </MarkerIcon>
        <MarkerContent className="shimmer">Working…</MarkerContent>
      </Marker>,
    );

    const marker = screen.getByRole("status");
    expect(marker.getAttribute("data-variant")).toBe("default");
    const content = marker.querySelector("[data-slot='marker-content']") as HTMLElement;
    expect(content.className).toContain("shimmer");
    expect(content.textContent).toBe("Working…");
    // The icon slot is decorative.
    expect(marker.querySelector("[data-slot='marker-icon']")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders a labeled separator variant", () => {
    render(
      <Marker variant="separator">
        <MarkerContent>Today</MarkerContent>
      </Marker>,
    );

    const marker = document.querySelector("[data-slot='marker']") as HTMLElement;
    expect(marker.getAttribute("data-variant")).toBe("separator");
    expect(marker.className).toContain("before:bg-[var(--border-default)]");
  });
});

describe("chat elements: Attachment", () => {
  afterEach(cleanup);

  it("renders metadata and shimmers the title while uploading", () => {
    render(
      <Attachment state="uploading" size="sm">
        <AttachmentMedia>
          <svg data-testid="file-icon" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>report.pdf</AttachmentTitle>
          <AttachmentDescription>PDF · 2.4 MB</AttachmentDescription>
        </AttachmentContent>
      </Attachment>,
    );

    const card = document.querySelector("[data-slot='attachment']") as HTMLElement;
    expect(card.getAttribute("data-state")).toBe("uploading");
    expect(card.getAttribute("data-size")).toBe("sm");
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("PDF · 2.4 MB")).toBeTruthy();
    const title = document.querySelector("[data-slot='attachment-title']") as HTMLElement;
    expect(title.className).toContain("group-data-[state=uploading]/attachment:shimmer");
  });

  it("lays out a scrollable, snapping attachment group with an edge fade", () => {
    render(
      <AttachmentGroup role="group" aria-label="Attachments" tabIndex={0}>
        <Attachment>
          <AttachmentContent>
            <AttachmentTitle>one.png</AttachmentTitle>
          </AttachmentContent>
        </Attachment>
        <Attachment>
          <AttachmentContent>
            <AttachmentTitle>two.png</AttachmentTitle>
          </AttachmentContent>
        </Attachment>
      </AttachmentGroup>,
    );

    const group = screen.getByRole("group", { name: "Attachments" });
    expect(group.className).toContain("scroll-fade-x");
    expect(group.className).toContain("snap-x");
    expect(document.querySelectorAll("[data-slot='attachment']").length).toBe(2);
  });
});

// The coding-agent transcript renders on the vendored primitives.
describe("AgentConversationView on chat primitives", () => {
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

  it("renders assistant markdown inside a full-width ghost bubble", () => {
    const events = [
      {
        type: "assistant.text.delta",
        eventId: "evt_d1",
        threadId: "thread_alpha",
        occurredAt: "2026-07-15T00:01:00.000Z",
        messageId: "msg_1",
        delta: "ghost bubble body",
      } as AgentThreadEvent,
      {
        type: "assistant.text.completed",
        eventId: "evt_c1",
        threadId: "thread_alpha",
        occurredAt: "2026-07-15T00:01:30.000Z",
        messageId: "msg_1",
      } as AgentThreadEvent,
    ];
    render(<AgentConversationView status="ready" snapshot={snapshot(events)} error={null} canSendTurns />);

    expect(screen.getByText("ghost bubble body")).toBeTruthy();
    const bubble = document.querySelector("[data-slot='bubble']") as HTMLElement;
    expect(bubble.getAttribute("data-variant")).toBe("ghost");
  });

  it("renders user message attachments as attachment cards without fetching images", () => {
    const events = [
      {
        type: "user.message",
        eventId: "evt_u1",
        threadId: "thread_alpha",
        occurredAt: "2026-07-15T00:00:30.000Z",
        messageId: "msg_u1",
        text: "compare these",
        attachments: [
          { id: "att_1", kind: "image", label: "homepage.png", mimeType: "image/png", sizeBytes: 2048 },
          { id: "att_2", kind: "file", label: "notes.md", sizeBytes: 512 },
        ],
      } as AgentThreadEvent,
    ];
    render(<AgentConversationView status="ready" snapshot={snapshot(events)} error={null} canSendTurns />);

    expect(screen.getByText("homepage.png")).toBeTruthy();
    expect(screen.getByText("notes.md")).toBeTruthy();
    expect(screen.getByText(/Image · 2 KB/)).toBeTruthy();
    // Attachment metadata never becomes an <img> fetch.
    expect(document.querySelector("img")).toBeNull();
  });

  it("renders a running tool call as a marker row with shimmer text", () => {
    const events = [
      {
        type: "tool.started",
        eventId: "evt_t1",
        threadId: "thread_alpha",
        occurredAt: "2026-07-15T00:03:00.000Z",
        toolCallId: "tc_1",
        displayName: "Shell command",
      } as AgentThreadEvent,
    ];
    render(<AgentConversationView status="ready" snapshot={snapshot(events)} error={null} canSendTurns />);

    const chip = screen.getByRole("button", { name: "Tool call Shell command" });
    const name = chip.querySelector("[data-slot='marker-content']") as HTMLElement;
    expect(name).not.toBeNull();
    expect(name.className).toContain("shimmer");
    expect(screen.getByLabelText("Running")).toBeTruthy();
  });

  it("renders the working indicator as a shimmer marker row", () => {
    render(<AgentConversationView status="ready" snapshot={snapshot([])} error={null} canSendTurns />);

    const status = screen.getByRole("status", { name: "Agent is working" });
    const content = status.querySelector("[data-slot='marker-content']") as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.className).toContain("shimmer");
    expect(content.textContent).toContain("Working…");
  });

  it("addresses transcript rows by message id for the scroller", () => {
    const events = [
      {
        type: "user.message",
        eventId: "evt_u1",
        threadId: "thread_alpha",
        occurredAt: "2026-07-15T00:00:30.000Z",
        messageId: "msg_u1",
        text: "start the turn",
      } as AgentThreadEvent,
    ];
    render(<AgentConversationView status="ready" snapshot={snapshot(events)} error={null} canSendTurns />);

    const row = document.querySelector("[data-message-id='user:msg_u1']") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute("data-scroll-anchor")).toBe("true");
  });
});
