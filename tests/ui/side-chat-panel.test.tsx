// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SideChatPanel } from "../../packages/ui/src/chat/SideChatPanel";

afterEach(cleanup);

it("keeps side answers in the side transcript and copies an editable draft to main", async () => {
  const empty = { threadId: null, messages: [] };
  const created = { threadId: "side_" + "a".repeat(32), messages: [] };
  const answered = { threadId: created.threadId, messages: [
    { seq: 1, role: "user" as const, content: "Question", createdAt: "2026-11-12T00:00:00.000Z" },
    { seq: 2, role: "assistant" as const, content: "Draft answer", createdAt: "2026-11-12T00:00:01.000Z" },
  ] };
  const client = { getSideChat: vi.fn(async () => empty), createSideChat: vi.fn(async () => created), askSideChat: vi.fn(async () => answered) };
  const sendToMain = vi.fn();
  render(<SideChatPanel chatId="chat_main" client={client} onSendToMain={sendToMain}/>);
  await screen.findByText(/Ask about this chat/);
  fireEvent.change(screen.getByRole("textbox", { name: "Ask side chat" }), { target: { value: "Question" } });
  fireEvent.click(screen.getByRole("button", { name: "Send side question" }));
  await waitFor(() => expect(client.askSideChat).toHaveBeenCalledWith("chat_main", expect.objectContaining({ text: "Question" })));
  fireEvent.click(await screen.findByRole("button", { name: "Send to main chat" }));
  expect(sendToMain).toHaveBeenCalledWith("Draft answer");
});
