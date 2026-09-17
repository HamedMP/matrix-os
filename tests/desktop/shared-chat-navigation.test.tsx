// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopChatCollaboration from "../../desktop/src/renderer/src/features/chat/DesktopChatCollaboration";
import { CanonicalChatRoute } from "../../desktop/src/renderer/src/features/chat/CanonicalChatRoute";
import { CanonicalChatWorkspace } from "../../desktop/src/renderer/src/features/chat/CanonicalChatWorkspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import {
  canonicalChatRecord,
  createCanonicalChatWorkspaceClient,
  providerCatalog,
} from "./canonical-chat-workspace-test-utils";

const scopeId = "10000000-0000-4000-8000-000000000001";
const sharedScope = {
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
} as const;
const sharedChat = {
  id: "chat_shared",
  scopeId,
  title: "Launch plan",
  lifecycle: "active",
  revision: "1",
  messageCount: "0",
} as const;

vi.mock("../../desktop/src/renderer/src/lib/collaboration", () => ({
  createDesktopCollaborationApi: () => ({
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/inbox")) return { items: [] };
      if (path.includes("/chat/messages")) return { messages: [] };
      if (path.endsWith("/chat/requests")) throw new Error("SharedAiUnavailable");
      if (path.endsWith("/chat")) return sharedChat;
      if (path.endsWith(`/scopes/${scopeId}`)) return sharedScope;
      return {
      items: [{
        scopeId,
        runtimeId: "vps:11111111-1111-4111-8111-111111111111",
        ownerId: "user_owner",
        kind: "chat",
        authorityGeneration: 1,
        status: "accepted",
        resource: {
          scope: sharedScope,
          chat: sharedChat,
        },
      }],
    };
    }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }),
}));

describe("Electron Shared with me navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    useConnection.setState({
      ...useConnection.getInitialState(),
      userId: "user_editor",
      platformHost: "https://app.matrix-os.com",
    }, true);
    useTabs.setState({ ...useTabs.getInitialState(), tabs: [], activeTabId: null }, true);
  });

  afterEach(cleanup);

  it("hands an accepted shared Chat to the canonical Chat workspace", async () => {
    render(<DesktopChatCollaboration />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Chat" }));

    const active = useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId);
    expect(active).toMatchObject({
      kind: "work",
      workRoute: "chat",
      title: "Chat",
      chatTitle: "Launch plan",
      sharedScopeId: scopeId,
    });
    expect(screen.queryByRole("heading", { name: "Launch plan" })).toBeNull();
  });

  it("renders the selected scope inside the canonical Chat workspace", async () => {
    render(
      <CanonicalChatWorkspace
        client={createCanonicalChatWorkspaceClient()}
        projectId={null}
        sharedScopeId={scopeId}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeVisible();
    expect(document.querySelector('[data-slot="canonical-chat-workspace"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="shared-chat-panel"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discussion" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Ask AI" })).toBeDisabled();
  });

  it("opens an explicit shared scope even when the local canonical route probe is unavailable", async () => {
    const unavailableApi = {
      baseUrl: "http://127.0.0.1:4010",
      get: vi.fn(async () => { throw new Error("GatewayUnavailable"); }),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    render(
      <CanonicalChatRoute
        api={unavailableApi as never}
        projectId={null}
        sharedScopeId={scopeId}
        active
        fallback={<div>Legacy fallback</div>}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeVisible();
    expect(screen.queryByText("Legacy fallback")).toBeNull();
    expect(unavailableApi.get).not.toHaveBeenCalled();
  });

  it("converts an owner's canonical Chat when its backend projection is shared", async () => {
    const routeClient = createCanonicalChatWorkspaceClient();
    const sharedRecord = {
      ...canonicalChatRecord,
      chat: {
        ...canonicalChatRecord.chat,
        id: sharedChat.id,
        collaboration: {
          mode: "shared",
          membership: {
            role: "owner",
            memberCount: 2,
          },
        },
      },
    };
    vi.mocked(routeClient.list).mockResolvedValue({ items: [sharedRecord] } as never);
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record: sharedRecord,
      messages: [],
      turns: [],
      runs: [],
      activities: [],
    } as never);

    render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId={null}
        initialChatId={sharedChat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeVisible();
    expect(document.querySelector('[data-slot="shared-chat-panel"]')).toBeTruthy();
  });
});
