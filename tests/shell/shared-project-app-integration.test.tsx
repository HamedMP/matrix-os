// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";

const projectScope = "10000000-0000-4000-8000-000000000a01";
const chatScope = "10000000-0000-4000-8000-000000000c01";
const push = vi.fn();

const scope = {
  id: projectScope,
  ownerId: "user_owner",
  kind: "project",
  resourceId: "proj_542a8126",
  membershipMode: "direct",
  lifecycle: "shared",
  revision: "5",
  authEpoch: "1",
  authorityGeneration: "1",
  role: "editor",
  capabilities: {
    read: true, discuss: true, manageMembers: false, requestAi: false,
    observeTerminal: false, controlTerminal: false, stopTerminal: false,
  },
};
const overview = {
  projectId: "proj_542a8126",
  scopeId: projectScope,
  name: "collab testing 12PMOct3",
  status: "active",
  chats: [{ scopeId: chatScope, chatId: "chat_release", title: "Release plan", updatedAt: "2026-10-03T12:00:00.000Z" }],
};

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, userId: "user_member" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));
vi.mock("../../shell/src/hooks/useBrowserOrigin", () => ({
  useBrowserOrigin: () => "https://app.matrix-os.com",
}));
vi.mock("../../shell/src/lib/collaboration", () => ({
  releaseShellCollaborationApi: vi.fn(),
  createShellCollaborationApi: () => ({
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path.includes("/inbox")) return { items: [] };
      if (path.includes("/shared")) return {
        items: [{
          scopeId: projectScope,
          runtimeId: "vps:11111111-1111-4111-8111-111111111111",
          ownerId: "user_owner",
          kind: "project",
          authorityGeneration: 1,
          status: "accepted",
          resource: {
            scope,
            project: { id: "proj_542a8126", scopeId: projectScope, status: "active", resources: [] },
            overview,
          },
        }],
      };
      if (path.endsWith("/project/overview")) return overview;
      if (path.endsWith(`/scopes/${projectScope}`)) return scope;
      throw new Error("UnexpectedRequest");
    }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  }),
}));

function renderChatApp(props: Partial<React.ComponentProps<typeof ChatApp>>) {
  return render(
    <ChatApp
      messages={[]}
      sessionId={undefined}
      busy={false}
      connected
      conversations={[]}
      onNewChat={vi.fn()}
      onSwitchConversation={vi.fn()}
      onSubmit={vi.fn()}
      {...props}
    />,
  );
}

describe("web Chats shared project", () => {
  it("lists a shared project by name and opens it inside the Chats app", async () => {
    const openSharedProject = vi.fn();
    renderChatApp({ collaborationView: { kind: "home" }, onOpenSharedProject: openSharedProject });

    expect(await screen.findByText("collab testing 12PMOct3")).toBeVisible();
    expect(screen.queryByText("proj_542a8126")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));

    expect(openSharedProject).toHaveBeenCalledWith(projectScope);
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the project's name, the member's role and its Chats, and opens a Chat in place", async () => {
    const openSharedChat = vi.fn();
    renderChatApp({ collaborationView: { kind: "project", scopeId: projectScope }, onOpenSharedChat: openSharedChat });

    expect(await screen.findByRole("heading", { name: "collab testing 12PMOct3" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Shared project" })).toBeVisible();
    expect(screen.getByText(/Editor · can edit/)).toBeVisible();
    expect(document.querySelector('[data-slot="chat-app-collaboration"]')).toBeTruthy();
    expect(screen.queryByText("proj_542a8126")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Release plan/ }));

    expect(openSharedChat).toHaveBeenCalledWith(chatScope);
    expect(push).not.toHaveBeenCalled();
  });
});
