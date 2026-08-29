// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscript } from "../../desktop/src/renderer/src/components/conversation/transcript";
import type { ConversationTurnPresentation } from "../../desktop/src/renderer/src/components/conversation/presentation";
import {
  adaptProjectLikeConversation,
  type ProjectLikeConversationTurn,
} from "./fixtures/project-like-conversation-adapter";

describe("provider-neutral conversation transcript", () => {
  beforeEach(() => {
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
  });

  afterEach(cleanup);

  it("renders typed non-Hermes adapter output without importing a provider store", () => {
    const sourceTurns: ProjectLikeConversationTurn[] = [{
      id: "turn-synthetic",
      startedAt: 1_000,
      endedAt: 6_000,
      active: false,
      userText: "Inspect the workspace",
      events: [
        {
          kind: "commentary",
          id: "commentary-synthetic",
          text: "I’ll inspect the repository first.",
          timestamp: 2_000,
        },
        {
          kind: "command",
          id: "command-synthetic",
          command: "git status --short",
          state: "completed",
          timestamp: 3_000,
        },
        {
          kind: "final",
          id: "final-synthetic",
          text: "The workspace is clean.",
          timestamp: 6_000,
        },
      ],
    }];
    const turns = adaptProjectLikeConversation(sourceTurns);

    render(<ConversationTranscript turns={turns} callbacks={{ copyText: vi.fn() }} />);

    const receipt = screen.getByRole("button", { name: "Worked for 5s" });
    expect(screen.getByText("Inspect the workspace")).toBeTruthy();
    expect(screen.getByText("The workspace is clean.")).toBeTruthy();
    expect(screen.queryByText("I’ll inspect the repository first.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ran command: git status --short" })).toBeNull();

    fireEvent.click(receipt);

    expect(screen.getByText("I’ll inspect the repository first.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ran command: git status --short" })).toBeTruthy();
  });

  it("expands a long user message accessibly and keeps structured references and metadata", async () => {
    const copyText = vi.fn(async () => {});
    const longMessage = `${"Inspect the canonical transcript carefully. ".repeat(30)}Final sentence.`;
    const turns: ConversationTurnPresentation[] = [{
      id: "turn-long-user-message",
      startedAt: 1_000,
      endedAt: 2_000,
      active: false,
      user: {
        kind: "message",
        id: "message-long-user",
        role: "user",
        phase: "commentary",
        markdown: longMessage,
        copyText: longMessage,
        timestamp: 1_000,
        references: [
          { id: "attachment-log", kind: "file", label: "run.log" },
          { id: "project-matrix", kind: "resource", label: "Matrix OS" },
          { id: "skill-review", kind: "invocation", label: "/review" },
        ],
      },
      work: [],
    }];

    render(<ConversationTranscript turns={turns} callbacks={{ copyText }} />);

    const expand = screen.getByRole("button", { name: "Show full message" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(longMessage)).toBeNull();
    expect(screen.getByText("run.log")).toBeTruthy();
    expect(screen.getByText("Matrix OS")).toBeTruthy();
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.getByLabelText("User message sent at 1970-01-01T00:00:01.000Z")).toBeTruthy();

    fireEvent.click(expand);
    expect(screen.getByText(longMessage)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Copy user message" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(longMessage));
  });

  it("renders skill and folder references inline with user text and shows uploaded images", () => {
    const turns: ConversationTurnPresentation[] = [{
      id: "turn-inline-user-content",
      startedAt: 1_000,
      endedAt: 2_000,
      active: false,
      user: {
        kind: "message",
        id: "message-inline-user",
        role: "user",
        phase: "commentary",
        markdown: "/matrix-app-builder create a game in [apps](apps) using this screenshot",
        copyText: "/matrix-app-builder create a game in [apps](apps) using this screenshot",
        timestamp: 1_000,
        content: [
          { kind: "reference", id: "matrix-app-builder", referenceKind: "invocation", label: "/matrix-app-builder" },
          { kind: "text", text: " create a game in " },
          { kind: "reference", id: "apps", referenceKind: "resource", label: "apps" },
          { kind: "text", text: " using this screenshot" },
          {
            kind: "image",
            id: "attachment-screenshot",
            label: "Screenshot.png",
            src: "/api/files/blob?path=temporary%2Fdesktop-chat%2FScreenshot.png",
          },
        ],
      },
      work: [],
    }];

    render(<ConversationTranscript turns={turns} callbacks={{ copyText: vi.fn() }} />);

    const bubble = screen.getByText("create a game in", { exact: false }).closest('[data-slot="bubble-content"]');
    expect(bubble).toBeTruthy();
    expect(screen.getByText("/matrix-app-builder")).toBeTruthy();
    expect(screen.getByText("apps")).toBeTruthy();
    expect(screen.queryByText("[apps](apps)")).toBeNull();
    const screenshot = screen.getByRole("img", { name: "Screenshot.png" });
    expect(screenshot.getAttribute("src")).toBe("/api/files/blob?path=temporary%2Fdesktop-chat%2FScreenshot.png");
  });

  it("uses a rotating progress indicator and a compact terminal failure outcome", () => {
    const turns: ConversationTurnPresentation[] = [{
      id: "turn-running-command",
      startedAt: 1_000,
      endedAt: 2_000,
      active: true,
      work: [{
        kind: "activity-group",
        id: "activities-running",
        activities: [{
          id: "activity-running",
          kind: "command",
          state: "running",
          label: "Run build",
          preview: "pnpm build",
          previewKind: "command",
        }],
      }],
      final: {
        kind: "notice",
        id: "run-failed",
        phase: "final",
        tone: "failed",
        label: "Agent work failed",
        markdown: "A command failed during this Run.",
        timestamp: 2_000,
      },
    }];

    render(<ConversationTranscript turns={turns} callbacks={{ copyText: vi.fn() }} />);

    const activity = screen.getByRole("button", { name: "Run build: pnpm build" });
    const progress = activity.querySelector("svg:last-of-type");
    expect(progress?.getAttribute("class")).toContain("animate-spin");
    expect(progress?.getAttribute("class")).not.toContain("status-pulse");
    const failure = screen.getByRole("status", { name: "Agent work failed" });
    expect(failure.className).not.toContain("rounded-xl");
    expect(failure.getAttribute("style") ?? "").not.toContain("background:");
  });

  it("renders provider-neutral approval actions through transcript callbacks", async () => {
    const performAction = vi.fn(async () => {});
    const turns: ConversationTurnPresentation[] = [{
      id: "turn-approval",
      startedAt: 1_000,
      endedAt: 2_000,
      active: true,
      work: [{
        kind: "request",
        id: "request-approval",
        phase: "commentary",
        requestKind: "approval",
        requestId: "approval-command",
        state: "waiting",
        label: "Run the command",
        detail: "This command writes to the workspace.",
        risk: "medium",
        timestamp: 1_500,
        actions: [
          { kind: "approval", requestId: "approval-command", decision: "approve", label: "Approve" },
          { kind: "approval", requestId: "approval-command", decision: "decline", label: "Decline" },
        ],
      }],
    }];

    render(<ConversationTranscript turns={turns} callbacks={{ copyText: vi.fn(), performAction }} />);

    expect(screen.getByRole("group", { name: "Approval required: Run the command" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve Run the command" }));
    await waitFor(() => expect(performAction).toHaveBeenCalledWith({
      kind: "approval",
      requestId: "approval-command",
      decision: "approve",
      label: "Approve",
    }, undefined));
  });

  it("reveals a newly streamed assistant chunk progressively", () => {
    vi.useFakeTimers();
    const text = "A streamed response should not appear as one abrupt block.";
    const turns: ConversationTurnPresentation[] = [{
      id: "turn-streaming",
      startedAt: 1_000,
      endedAt: 1_000,
      active: true,
      work: [],
      final: {
        kind: "message",
        id: "message-streaming",
        role: "assistant",
        phase: "final",
        markdown: text,
        copyText: text,
        timestamp: 1_000,
      },
    }];

    try {
      const { container } = render(
        <ConversationTranscript turns={turns} callbacks={{ copyText: vi.fn() }} />,
      );
      const response = container.querySelector(
        '[data-slot="message"][data-align="start"] [data-selectable]',
      );
      expect(response?.textContent).toBe("");

      act(() => vi.advanceTimersByTime(32));
      expect(response?.textContent?.length).toBeGreaterThan(0);
      expect(response?.textContent?.length).toBeLessThan(text.length);

      for (let frame = 0; frame < 120; frame += 1) {
        act(() => vi.advanceTimersByTime(16));
      }
      expect(response?.textContent).toBe(text);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the complete streamed response as soon as its turn terminalizes", () => {
    vi.useFakeTimers();
    const text = `${"terminal_output_".repeat(5_000)}done`;
    const activeTurn: ConversationTurnPresentation = {
      id: "turn-terminalizing-stream",
      startedAt: 1_000,
      endedAt: 1_000,
      active: true,
      work: [],
      final: {
        kind: "message",
        id: "message-terminalizing-stream",
        role: "assistant",
        phase: "final",
        markdown: text,
        copyText: text,
        timestamp: 1_000,
      },
    };

    try {
      const { container, rerender } = render(
        <ConversationTranscript turns={[activeTurn]} callbacks={{ copyText: vi.fn() }} />,
      );
      const response = container.querySelector(
        '[data-slot="message"][data-align="start"] [data-selectable]',
      );

      act(() => vi.advanceTimersByTime(32));
      expect(response?.textContent?.length).toBeGreaterThan(0);
      expect(response?.textContent?.length).toBeLessThan(text.length);

      rerender(
        <ConversationTranscript
          turns={[{ ...activeTurn, active: false, endedAt: 2_000 }]}
          callbacks={{ copyText: vi.fn() }}
        />,
      );

      expect(response?.textContent?.length).toBe(text.length);
      expect(response?.textContent).toBe(text);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps durable partial output visible beside an aborted terminal notice", () => {
    vi.useFakeTimers();
    const partial = "Durable partial output that must remain visible after cancellation.";
    const activeTurn: ConversationTurnPresentation = {
      id: "turn-aborted-partial",
      startedAt: 1_000,
      endedAt: 1_000,
      active: true,
      work: [],
      final: {
        kind: "message",
        id: "message-aborted-partial",
        role: "assistant",
        phase: "final",
        markdown: partial,
        copyText: partial,
        timestamp: 1_000,
      },
    };

    try {
      const { rerender } = render(
        <ConversationTranscript turns={[activeTurn]} callbacks={{ copyText: vi.fn() }} />,
      );
      act(() => vi.advanceTimersByTime(32));
      expect(screen.getByText((content) => content.length > 0 && partial.startsWith(content))).toBeTruthy();

      rerender(
        <ConversationTranscript
          turns={[{
            ...activeTurn,
            active: false,
            endedAt: 2_000,
            work: [{ ...activeTurn.final!, phase: "commentary" }],
            final: {
              kind: "notice",
              id: "run-aborted-terminal",
              phase: "final",
              tone: "stopped",
              label: "Agent work stopped",
              markdown: "Run was cancelled.",
              timestamp: 2_000,
            },
          }]}
          callbacks={{ copyText: vi.fn() }}
        />,
      );

      expect(screen.getByText(partial)).toBeTruthy();
      expect(screen.getByText("Run was cancelled.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reveals a live response progressively when polling first sees it as completed", () => {
    vi.useFakeTimers();
    const text = "A completed polling frame should still arrive smoothly.";
    const activeTurn: ConversationTurnPresentation = {
      id: "turn-fast-completion",
      startedAt: 1_000,
      endedAt: 1_000,
      active: true,
      work: [],
    };

    try {
      const { container, rerender } = render(
        <ConversationTranscript turns={[activeTurn]} callbacks={{ copyText: vi.fn() }} />,
      );
      rerender(
        <ConversationTranscript
          turns={[{
            ...activeTurn,
            active: false,
            endedAt: 2_000,
            final: {
              kind: "message",
              id: "message-fast-completion",
              role: "assistant",
              phase: "final",
              markdown: text,
              copyText: text,
              timestamp: 2_000,
            },
          }]}
          callbacks={{ copyText: vi.fn() }}
        />,
      );

      const response = container.querySelector(
        '[data-slot="message"][data-align="start"] [data-selectable]',
      );
      expect(response?.textContent).toBe("");

      act(() => vi.advanceTimersByTime(32));
      expect(response?.textContent?.length).toBeGreaterThan(0);
      expect(response?.textContent?.length).toBeLessThan(text.length);

      for (let frame = 0; frame < 120; frame += 1) {
        act(() => vi.advanceTimersByTime(16));
      }
      expect(response?.textContent).toBe(text);
    } finally {
      vi.useRealTimers();
    }
  });
});
