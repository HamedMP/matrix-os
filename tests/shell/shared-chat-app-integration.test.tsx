// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";

const scopeId = "10000000-0000-4000-8000-000000000001";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, userId: "user_editor" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../../shell/src/hooks/useBrowserOrigin", () => ({
  useBrowserOrigin: () => "https://app.matrix-os.com",
}));
vi.mock("../../shell/src/lib/collaboration", () => ({
  createShellCollaborationApi: () => ({
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path.includes("/inbox")) return { items: [] };
      if (path.includes("/shared")) return {
        items: [{
          scopeId,
          runtimeId: "vps:11111111-1111-4111-8111-111111111111",
          ownerId: "user_owner",
          kind: "chat",
          authorityGeneration: 1,
          status: "accepted",
          resource: {
            scope: {
              id: scopeId,
              ownerId: "user_owner",
              kind: "chat",
              resourceId: "chat_shared",
              membershipMode: "direct",
              lifecycle: "shared",
              revision: "1",
              authEpoch: "1",
              authorityGeneration: "1",
              role: "editor",
              capabilities: {
                read: true,
                discuss: true,
                manageMembers: false,
                requestAi: false,
                observeTerminal: false,
                controlTerminal: false,
                stopTerminal: false,
              },
            },
            chat: {
              id: "chat_shared",
              scopeId,
              title: "Launch plan",
              lifecycle: "active",
              revision: "1",
              messageCount: "0",
            },
          },
        }],
      };
      if (path.includes("/chat/messages")) return { messages: [] };
      if (path.endsWith("/chat/requests")) throw new Error("SharedAiUnavailable");
      if (path.endsWith("/chat")) return {
        id: "chat_shared",
        scopeId,
        title: "Launch plan",
        lifecycle: "active",
        revision: "1",
        messageCount: "0",
      };
      return {
        id: scopeId,
        ownerId: "user_owner",
        kind: "chat",
        resourceId: "chat_shared",
        membershipMode: "direct",
        lifecycle: "shared",
        revision: "1",
        authEpoch: "1",
        authorityGeneration: "1",
        role: "editor",
        capabilities: {
          read: true,
          discuss: true,
          manageMembers: false,
          requestAi: false,
          observeTerminal: false,
          controlTerminal: false,
          stopTerminal: false,
        },
      };
    }),
    post: vi.fn(),
    patch: vi.fn(async () => ({ readThroughSeq: "0", pinned: false, muted: false })),
    delete: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  }),
}));

describe("web Chat shared collaboration integration", () => {
  it("keeps the normal Chat frame while rendering the shared controller", async () => {
    render(
      <ChatApp
        collaborationView={{ kind: "chat", scopeId }}
        messages={[]}
        sessionId={undefined}
        busy={false}
        connected
        conversations={[]}
        onNewChat={vi.fn()}
        onSwitchConversation={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeVisible();
    expect(document.querySelector('[data-slot="chat-app-collaboration"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="shared-chat-panel"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Discussion" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Ask AI" })).toBeDisabled();
    expect(screen.getByText("Live shared collaboration")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Setup" })).toBeNull();
  });

  it("opens a Shared with me selection in the same Chat app", async () => {
    const openSharedChat = vi.fn();
    render(
      <ChatApp
        collaborationView={{ kind: "home" }}
        onOpenSharedChat={openSharedChat}
        messages={[]}
        sessionId={undefined}
        busy={false}
        connected
        conversations={[]}
        onNewChat={vi.fn()}
        onSwitchConversation={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open Chat" }));

    expect(openSharedChat).toHaveBeenCalledWith(scopeId);
    expect(document.querySelector('[data-slot="chat-app-collaboration"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeVisible();
  });

  it("resolves an owner's normalized canonical projection through the collaboration directory", async () => {
    render(
      <ChatApp
        collaborationView={{ kind: "canonical-chat", chatId: "chat_shared" }}
        messages={[]}
        sessionId="chat_shared"
        busy={false}
        connected
        conversations={[]}
        onNewChat={vi.fn()}
        onSwitchConversation={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeVisible();
    expect(document.querySelector('[data-slot="chat-app-collaboration"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="shared-chat-panel"]')).toBeTruthy();
  });
});
