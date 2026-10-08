// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalNewChatContent } from "@desktop/renderer/src/features/chat/CanonicalNewChatContent";

vi.mock("@desktop/renderer/src/features/chat/ChatProviderOnboarding", () => ({
  ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <div data-testid="harness-setup">{children}</div>,
}));
vi.mock("@desktop/renderer/src/features/chat/ChatStarterCards", () => ({
  ChatStarterCards: () => <div data-testid="starter-cards" />,
}));

afterEach(() => { cleanup(); });

describe("a new chat's greeting in Electron Desktop", () => {
  it("shows a host's Bot greeting with no harness setup and no starter cards", () => {
    render(<CanonicalNewChatContent projectId={null} workspaceLayout="wide" composer={<textarea aria-label="Start a chat" />}
      onSelect={vi.fn()} welcome={{ title: "Ask about matrix-os", detail: "Answers come only from this project's brain." }} />);
    expect(screen.getByRole("heading", { name: "Ask about matrix-os" })).toBeTruthy();
    expect(screen.queryByTestId("harness-setup")).toBeNull();
    expect(screen.queryByTestId("starter-cards")).toBeNull();
  });

  it("keeps the harness setup and starter cards around the Chat tab's own greeting", () => {
    render(<CanonicalNewChatContent projectId={null} workspaceLayout="wide" composer={<textarea aria-label="Start a chat" />}
      onSelect={vi.fn()} />);
    expect(screen.getByTestId("harness-setup")).toContainElement(screen.getByRole("heading", { name: "What should we build today?" }));
    expect(screen.getByTestId("starter-cards")).toBeTruthy();
  });
});
