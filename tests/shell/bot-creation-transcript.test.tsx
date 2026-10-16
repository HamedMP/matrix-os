// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { WebCreationTranscript } from "../../shell/src/components/chat/WebCreationTranscript";
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const now = "2026-10-14T00:00:00.000Z";
const detail: CanonicalChatDetailResponse = {
  record: { chat: { id: "chat_creation", ownerScope: { type: "personal", ownerId: "owner" }, title: "New agent",
    lifecycle: "active", attention: "none", revision: 0, messageCount: 2, createdAt: now, updatedAt: now } },
  messages: [
    { id: "msg_user", chatId: "chat_creation", seq: 1, role: "user", state: "committed", createdAt: now,
      parts: [{ type: "text", text: "Please configure an agent" }] },
    { id: "msg_assistant", chatId: "chat_creation", seq: 2, role: "assistant", state: "committed", createdAt: now,
      parts: [{ type: "text", text: "Actual gateway response" }] },
  ], turns: [], runs: [], activities: [],
};
it("renders actual canonical readback messages with the shared production message components", () => {
  render(<WebCreationTranscript detail={detail}/>);
  expect(screen.getByText("Please configure an agent")).toBeVisible();
  expect(screen.getByText("Actual gateway response")).toBeVisible();
});
it("does not fabricate an assistant response for an empty drafting chat", () => {
  const view = render(<WebCreationTranscript detail={{ ...detail, messages: [] }}/>);
  expect(view.container.textContent).not.toContain("Actual gateway response");
  expect(view.container.textContent).not.toContain("Please configure an agent");
});
