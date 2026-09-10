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
