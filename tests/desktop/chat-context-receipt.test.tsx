// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ChatContextReceipt } from "../../packages/ui/src/chat-agents/ChatContextReceipt";
afterEach(cleanup);
it("renders persisted source text and truncation without loading a new preview", () => {
  render(<ChatContextReceipt context={{ version: 1, requestHash: "a".repeat(64),
    agent: { id: "bot_meeting01", revision: 2, name: "Meeting helper", instructions: "Prepare" },
    chats: [{ chatId: "chat_notes", title: "Notes at send time", throughSeq: 8, text: "Pinned notes", truncated: true }] }} />);
  expect(screen.getByText("Meeting helper · Hermes")).toBeTruthy();
  fireEvent.click(screen.getByText("Context used · 1 Chat"));
  expect(screen.getByText("Pinned notes")).toBeTruthy();
  expect(screen.getByText(/through message 8/)).toBeTruthy();
});
it("adds nothing to an ordinary turn", () => {
  const { container } = render(<ChatContextReceipt />);
  expect(container.textContent).toBe("");
});
it("shows immutable recipe provenance from the admitted Run without fetching", () => {
  render(<ChatContextReceipt context={{ version: 1, requestHash: "b".repeat(64), chats: [],
    agent: { id: "bot_brief0001", revision: 3, name: "Personal Daily Brief", instructions: "Prepare it", recipe: {
      skills: [{ id: "matrix-personal-daily-brief", name: "Personal Daily Brief",
        instructions: "Detailed server-pinned instructions that stay collapsed", sha256: "c".repeat(64) }],
      integrations: [
        { service: "gmail", accountLabel: "Work" },
        { service: "google_calendar" },
      ],
      output: "A source-linked daily brief.",
    } },
  }} />);

  fireEvent.click(screen.getByText("Recipe used"));
  expect(screen.getByTitle(/^Personal Daily Brief · sha256:/)).toBeTruthy();
  expect(screen.getByText(/cccccccccccc/)).toBeTruthy();
  expect(screen.getByText("Selected integrations")).toBeTruthy();
  expect(screen.getByTitle("Gmail · Work")).toBeTruthy();
  expect(screen.getByTitle("Google Calendar · Ask when run")).toBeTruthy();
  expect(screen.getByText("A source-linked daily brief.")).toBeTruthy();
  expect(screen.queryByText(/Detailed server-pinned instructions/)).toBeNull();
});
