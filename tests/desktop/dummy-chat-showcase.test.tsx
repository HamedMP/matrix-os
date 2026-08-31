// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DummyChatShowcase } from "@desktop/renderer/src/features/work/DummyChatShowcase";

vi.mock("@desktop/renderer/src/features/chat/SharedChatComposer", () => ({
  SharedChatComposer: ({ onSubmit }: { onSubmit: (submission: { text: string; agentPrompt: string; invocations: []; resources: [] }) => void }) => (
    <div data-slot="shared-chat-composer">
      <button type="button" onClick={() => onSubmit({ text: "Add one more state", agentPrompt: "Add one more state", invocations: [], resources: [] })}>
        Send dummy message
      </button>
    </div>
  ),
}));

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});

afterEach(() => cleanup());

describe("DummyChatShowcase", () => {
  it("renders a realistic frontend-only conversation with every transcript family", () => {
    render(<DummyChatShowcase />);

    expect(screen.getByRole("log")).toBeTruthy();
    expect(screen.getByText(/Build a release dashboard/)).toBeTruthy();
    expect(screen.getByText("Implementation summary")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Worked for 12s" }));
    expect(screen.getByRole("button", { name: /Analyzed the request/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Prepared the workspace/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ran the focused test suite/ })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Preview needs attention" })).toBeTruthy();
    expect(screen.getByRole("group", { name: /Approval required: Deploy the preview/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: /Input required: Choose a release channel/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Dashboard preview" })).toBeTruthy();
    expect(screen.getByText("Matrix OS")).toBeTruthy();
    expect(screen.getByText("/review")).toBeTruthy();
    expect(document.querySelector('[data-slot="shared-chat-composer"]')).toBeTruthy();
  });

  it("keeps composer submissions local to the showcase", async () => {
    render(<DummyChatShowcase />);

    fireEvent.click(screen.getByRole("button", { name: "Send dummy message" }));

    expect(screen.getByText("Add one more state")).toBeTruthy();
    expect(await screen.findByText("This reply was generated locally for the component showcase.")).toBeTruthy();
  });
});
