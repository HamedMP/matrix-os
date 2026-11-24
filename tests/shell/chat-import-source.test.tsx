// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";
// No projects on this computer, so the source-filter empty state applies to the main list alone.
vi.mock("../../shell/src/components/chat/web-projects", async (original) => ({
  ...await original<typeof import("../../shell/src/components/chat/web-projects")>(),
  useWebProjects: () => ({ identity: "owner", projects: [], loading: false, error: false, retry: () => {} }),
}));
vi.mock("@clerk/nextjs", () => ({ useOrganization: () => ({ organization: null }), useAuth: () => ({ userId: null, sessionId: null }) }));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../shell/src/components/chat/ChatInput", () => ({ ChatInput: () => null }));
vi.mock("@matrix-os/ui", async original => ({ ...await original<typeof import("@matrix-os/ui")>(),
  useBotConversationSummaries: () => ({ conversations: [], unresolvedChatIds: [], loading: false, error: null }),
  ChatAgentsRailSection: () => null,
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("keeps source filtering and inline search combined in the existing phone layout", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const conversations = ["plain", "claude", "codex"].map(name => ({ id: `chat_${name}`, title: `${name} release`, preview: "", messageCount: 1, updatedAt: 0,
    canonicalRecord: { chat: { id: `chat_${name}`, title: `${name} release`, revision: 0, messageCount: 1, lifecycle: "active" as const, attention: "none" as const, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }, ...(name === "plain" ? {} : { importSource: { harness: name as "claude" | "codex" } }) },
  }));
  render(<ChatApp mobile messages={[]} busy={false} sessionId={undefined} connected conversations={conversations} onSubmit={vi.fn()} onNewChat={vi.fn()} onSwitchConversation={vi.fn()}/>);
  expect(screen.getByRole("img", { name: "Imported from Claude Code" })).toBeTruthy();
  const filter = screen.getByRole("combobox", { name: "Chat source" });
  fireEvent.change(filter, { target: { value: "imported" } });
  expect(screen.queryByRole("button", { name: "plain release" })).toBeNull();
  expect(screen.getByRole("button", { name: "claude release" })).toBeTruthy();
  fireEvent.change(filter, { target: { value: "codex" } });
  expect(screen.queryByRole("button", { name: "claude release" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Search chats" }), { target: { value: "claude" } });
  expect(screen.queryByRole("button", { name: "codex release" })).toBeNull();
  expect(screen.getByText("No chats match this source.")).toBeTruthy();
  fireEvent.change(filter, { target: { value: "all" } });
  expect(screen.getByRole("button", { name: "claude release" })).toBeTruthy();
});
it("filters the desktop rail and keeps global Search available through its dialog", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const conversations = ["claude", "codex"].map(name => ({ id: `chat_${name}`, title: `${name} release`, preview: "", messageCount: 1, updatedAt: 0,
    canonicalRecord: { chat: { id: `chat_${name}`, title: `${name} release`, revision: 0, messageCount: 1, lifecycle: "active" as const, attention: "none" as const, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }, importSource: { harness: name as "claude" | "codex" } },
  }));
  render(<ChatApp messages={[]} busy={false} connected conversations={conversations} onSubmit={vi.fn()} onNewChat={vi.fn()} onSwitchConversation={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button", { name: "Filter chats" }));
  const filter = await screen.findByRole("combobox", { name: "Chat source" });
  fireEvent.change(filter, { target: { value: "codex" } });
  expect(screen.queryByRole("button", { name: "claude release" })).toBeNull();
  expect(screen.getByRole("button", { name: "codex release" })).toBeTruthy();
  fireEvent.keyDown(filter, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
  const query = await screen.findByRole("combobox", { name: "Search chats" });
  fireEvent.change(query, { target: { value: "claude" } });
  expect(await screen.findByRole("option", { name: /claude release/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /codex release/ })).toBeNull();
});
