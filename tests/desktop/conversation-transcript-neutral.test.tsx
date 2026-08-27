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

  it("renders structured references and keeps long user content keyboard-expandable", () => {
    const longUserText = Array.from({ length: 18 }, (_, index) => `line ${index}`).join("\n");
    const turns: ConversationTurnPresentation[] = [{
      id: "turn-structured",
      startedAt: 1_000,
      endedAt: 2_000,
      active: false,
      user: {
        kind: "message",
        id: "message-user-long",
        role: "user",
        phase: "commentary",
        markdown: longUserText,
        copyText: longUserText,
        timestamp: 1_000,
        references: [
          { id: "file-1", kind: "file", label: "spec.md" },
          { id: "resource-1", kind: "resource", label: "packages/gateway" },
          { id: "skill-1", kind: "invocation", label: "/review" },
        ],
      },
      work: [],
    }];

    render(<ConversationTranscript turns={turns} callbacks={{ copyText: vi.fn() }} />);

    expect(screen.getByText("spec.md")).toBeTruthy();
    expect(screen.getByText("packages/gateway")).toBeTruthy();
    expect(screen.getByText("/review")).toBeTruthy();
    const expand = screen.getByRole("button", { name: "Show full message" });
    fireEvent.keyDown(expand, { key: "Enter" });
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    expect(screen.getByText(/line 17/)).toBeTruthy();
  });

  it("exposes provider-neutral approval, requested-input, and retry actions", async () => {
    const performAction = vi.fn(async () => undefined);
    const turns: ConversationTurnPresentation[] = [{
      id: "turn-actions",
      startedAt: 1_000,
      endedAt: 1_000,
      active: true,
      work: [
        {
          kind: "request",
          id: "request-approval",
          phase: "commentary",
          requestKind: "approval",
          requestId: "approval-1",
          state: "waiting",
          label: "Apply changes",
          detail: "Allow the safe edit.",
          risk: "medium",
          timestamp: 1_000,
          actions: [
            { kind: "approval", requestId: "approval-1", decision: "approve", label: "Approve" },
            { kind: "approval", requestId: "approval-1", decision: "decline", label: "Decline" },
          ],
        },
        {
          kind: "request",
          id: "request-input",
          phase: "commentary",
          requestKind: "input",
          requestId: "input-1",
          state: "waiting",
          label: "Choose a target",
          timestamp: 1_000,
          actions: [{ kind: "input", requestId: "input-1", label: "Submit" }],
        },
      ],
      final: {
        kind: "notice",
        id: "notice-failed",
        phase: "final",
        tone: "failed",
        label: "Agent work failed",
        markdown: "The Run stopped safely.",
        timestamp: 1_000,
        actions: [{ kind: "retry", turnId: "turn-actions", label: "Retry" }],
      },
    }];

    render(
      <ConversationTranscript
        turns={turns}
        callbacks={{ copyText: vi.fn(), performAction, canPerformAction: () => true }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve Apply changes" }));
    expect(await screen.findByText("Allow the safe edit.")).toBeTruthy();
    const answer = screen.getByRole("textbox", { name: "Answer Choose a target" });
    fireEvent.change(answer, { target: { value: "Desktop" } });
    fireEvent.submit(answer.closest("form")!);
    fireEvent.click(screen.getByRole("button", { name: "Retry Agent work failed" }));

    await waitFor(() => expect(performAction).toHaveBeenCalledTimes(3));
    expect(performAction).toHaveBeenNthCalledWith(1, {
      kind: "approval",
      requestId: "approval-1",
      decision: "approve",
      label: "Approve",
    }, undefined);
    expect(performAction).toHaveBeenNthCalledWith(2, {
      kind: "input",
      requestId: "input-1",
      label: "Submit",
    }, "Desktop");
    expect(performAction).toHaveBeenNthCalledWith(3, {
      kind: "retry",
      turnId: "turn-actions",
      label: "Retry",
    }, undefined);
  });

  it("does not expose unsupported request actions", () => {
    const turns: ConversationTurnPresentation[] = [{
      id: "turn-readonly-request",
      startedAt: 1_000,
      endedAt: 1_000,
      active: true,
      work: [{
        kind: "request",
        id: "request-readonly",
        phase: "commentary",
        requestKind: "approval",
        requestId: "approval-readonly",
        state: "waiting",
        label: "Apply changes",
        timestamp: 1_000,
        actions: [{ kind: "approval", requestId: "approval-readonly", decision: "approve", label: "Approve" }],
      }],
    }];

    render(
      <ConversationTranscript
        turns={turns}
        callbacks={{ copyText: vi.fn(), performAction: vi.fn(), canPerformAction: () => false }}
      />,
    );

    expect(screen.getByRole("group", { name: "Approval required: Apply changes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve Apply changes" })).toBeNull();
  });
});
