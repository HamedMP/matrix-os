// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";

vi.mock("@clerk/nextjs", () => ({ useOrganization: () => ({ organization: null }), useAuth: () => ({ userId: null, sessionId: null }) }));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../shell/src/components/chat/web-projects", async (original) => ({
  ...await original<typeof import("../../shell/src/components/chat/web-projects")>(),
  useWebProjects: () => ({ identity: "owner", projects: [{ id: "proj_demo", slug: "demo", name: "Demo" }], loading: false, error: false, retry: () => {} }),
}));
vi.mock("../../shell/src/components/chat/ChatTicketBar", () => ({
  ChatTicketBar: ({ chatId, project }: { chatId: string; project?: { slug: string } }) => <div data-testid="ticket-bar">{chatId}:{project?.slug}</div>,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const base = { busy: false, connected: true, conversations: [], onSubmit: vi.fn(), onNewChat: vi.fn(), onSwitchConversation: vi.fn() };

// Fault detected: a task created on the board is an empty chat, and the ticket header only
// rendered once the chat had messages, so a fresh ticket could not be edited from its chat.
it("shows a project chat's ticket before its first message", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  render(<ChatApp {...base} messages={[]} sessionId="chat_task" chatProjectId="proj_demo" />);
  expect(screen.getByTestId("ticket-bar").textContent).toBe("chat_task:demo");
});

it("keeps the ticket once the chat has messages, and shows none outside a project", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const messages = [{ id: "m1", role: "user" as const, content: "Fix it", timestamp: Date.parse("2026-11-20T00:00:00Z") }];
  const { rerender } = render(<ChatApp {...base} messages={messages} sessionId="chat_task" chatProjectId="proj_demo" />);
  expect(screen.getByTestId("ticket-bar")).toBeTruthy();
  rerender(<ChatApp {...base} messages={messages} sessionId="chat_loose" />);
  expect(screen.queryByTestId("ticket-bar")).toBeNull();
});
