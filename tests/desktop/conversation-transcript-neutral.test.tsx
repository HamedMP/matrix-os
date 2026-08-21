// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscript } from "../../desktop/src/renderer/src/components/conversation/transcript";
import type { ConversationTurnPresentation } from "../../desktop/src/renderer/src/components/conversation/presentation";

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

  it("renders synthetic turn work, final output, and semantic activity without a provider adapter", () => {
    const turns: ConversationTurnPresentation[] = [{
      id: "turn-synthetic",
      startedAt: 1_000,
      endedAt: 6_000,
      active: false,
      user: {
        kind: "message",
        id: "user-synthetic",
        role: "user",
        phase: "final",
        markdown: "Inspect the workspace",
        copyText: "Inspect the workspace",
        timestamp: 1_000,
      },
      work: [
        {
          kind: "message",
          id: "commentary-synthetic",
          role: "assistant",
          phase: "commentary",
          markdown: "I’ll inspect the repository first.",
          copyText: "I’ll inspect the repository first.",
          timestamp: 2_000,
        },
        {
          kind: "activity-group",
          id: "activities-synthetic",
          activities: [{
            id: "command-synthetic",
            kind: "command",
            state: "completed",
            label: "Ran command",
            preview: "git status --short",
            previewKind: "command",
            copyText: "git status --short",
          }],
        },
      ],
      final: {
        kind: "message",
        id: "final-synthetic",
        role: "assistant",
        phase: "final",
        markdown: "The workspace is clean.",
        copyText: "The workspace is clean.",
        timestamp: 6_000,
      },
    }];

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
});
