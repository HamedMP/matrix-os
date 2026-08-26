// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
