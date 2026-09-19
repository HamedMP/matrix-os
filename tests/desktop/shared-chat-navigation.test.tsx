// @vitest-environment jsdom

import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopChatCollaboration from "../../desktop/src/renderer/src/features/chat/DesktopChatCollaboration";
import { CanonicalChatRoute } from "../../desktop/src/renderer/src/features/chat/CanonicalChatRoute";
import { CanonicalChatWorkspace } from "../../desktop/src/renderer/src/features/chat/CanonicalChatWorkspace";
import { SharedWithMeRailRow } from "../../desktop/src/renderer/src/features/work/WorkRail";
import { notifyCollaborationDiscoveryChanged } from "../../packages/ui/src/collaboration/discovery-events";
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
const collaborationMock = vi.hoisted(() => ({ pending: 0, failInbox: false }));

vi.mock("../../desktop/src/renderer/src/lib/collaboration", () => ({
  createDesktopCollaborationApi: () => ({
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/inbox") && collaborationMock.failInbox) throw new Error("InboxUnavailable");
      if (path.endsWith("/inbox")) return { items: collaborationMock.pending ? [{
        scopeId,
        runtimeId: "runtime_owner",
        ownerId: "user_owner",
        kind: "chat",
        authorityGeneration: 1,
        status: "invited",
        invitationId: "30000000-0000-4000-8000-000000000001",
        resource: {
          id: "30000000-0000-4000-8000-000000000001",
          scopeId,
          owner: { actorId: "user_owner", displayName: "Nima" },
          target: { actorId: "user_editor", displayName: "Ada" },
          scopeKind: "chat",
          role: "editor",
          status: "pending",
          expiresAt: "2026-09-19T12:00:00.000Z",
          revision: "2",
        },
      }] : [] };
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
    collaborationMock.pending = 0;
    collaborationMock.failInbox = false;
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

  it("uses the centralized desktop overlay layers for shared sessions", () => {
    const chatSource = readFileSync(resolve(
      process.cwd(),
      "desktop/src/renderer/src/features/chat/DesktopChatCollaboration.tsx",
    ), "utf8");
    const terminalSource = readFileSync(resolve(
      process.cwd(),
      "desktop/src/renderer/src/features/terminal/DesktopSharedTerminal.tsx",
    ), "utf8");

    for (const source of [chatSource, terminalSource]) {
      expect(source).toContain("DESKTOP_Z_INDEX.dialog");
      expect(source).toContain("DESKTOP_Z_INDEX.popover");
      expect(source).toContain("layers={COLLABORATION_LAYERS}");
    }
  });

  it("hands an accepted shared Chat to the canonical Chat workspace", async () => {
    render(<DesktopChatCollaboration />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Chat" }));

    const active = useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId);
    expect(active).toMatchObject({
      kind: "work",
      workRoute: "chat",
      title: "Chat",
      chatId: "chat_shared",
      chatTitle: "Launch plan",
      sharedScopeId: scopeId,
    });
    expect(screen.queryByRole("heading", { name: "Launch plan" })).toBeNull();
  });

  it("exposes Shared with me in the Chat rail and opens its native content", async () => {
    render(<SharedWithMeRailRow />);

    fireEvent.click(await screen.findByRole("button", { name: "Shared with me" }));
    expect(useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId)).toMatchObject({
      kind: "shared",
      title: "Shared with me",
    });
  });

  it("refreshes the pending badge after an invitation mutation", async () => {
    render(<SharedWithMeRailRow />);
    expect(await screen.findByRole("button", { name: "Shared with me" })).toBeVisible();
    collaborationMock.pending = 1;
    notifyCollaborationDiscoveryChanged();
    expect(await screen.findByLabelText("1 pending invitations")).toBeVisible();
  });

  it("keeps Shared with me available when only its pending count fails", async () => {
    collaborationMock.failInbox = true;
    render(<SharedWithMeRailRow />);

    expect(await screen.findByRole("button", { name: "Shared with me" })).toBeVisible();
    expect(screen.queryByLabelText(/pending invitations/)).toBeNull();
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

    expect(await screen.findByLabelText("Message Chat")).toBeDisabled();
    expect(document.querySelector('[data-slot="canonical-chat-workspace"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="native-shared-chat"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open discussion" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collaboration access" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Ask AI" })).toBeNull();
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

    expect(await screen.findByLabelText("Message Chat")).toBeDisabled();
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

    expect(await screen.findByLabelText("Message Chat")).toBeDisabled();
    expect(document.querySelector('[data-slot="native-shared-chat"]')).toBeTruthy();
  });
});
