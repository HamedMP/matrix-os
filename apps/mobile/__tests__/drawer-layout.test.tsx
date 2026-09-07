import type { CanonicalChatRecord } from "@matrix-os/contracts";

const registeredScreens: Array<{ name: string; options?: Record<string, unknown> }> = [];
let drawerScreenOptions: Record<string, unknown> | undefined;
let drawerScreenListeners: Record<string, () => void> | undefined;

const mockUseCanonicalChats = jest.fn();
const mockUseProjects = jest.fn();
const mockSelectChat = jest.fn();
const mockStartDraftChat = jest.fn();

jest.mock("@/lib/queries/use-canonical-chats", () => ({
  useCanonicalChats: () => mockUseCanonicalChats(),
}));

jest.mock("@/lib/queries/use-projects", () => ({
  useProjects: () => mockUseProjects(),
}));

jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({
    activeChatId: "chat-1",
    selectChat: mockSelectChat,
    startDraftChat: mockStartDraftChat,
  }),
}));

jest.mock("expo-router/drawer", () => {
  const React = require("react");
  function Drawer({ children, screenOptions, screenListeners }: {
    children: React.ReactNode;
    screenOptions?: unknown;
    screenListeners?: Record<string, () => void>;
  }) {
    drawerScreenOptions = typeof screenOptions === "function"
      ? screenOptions({ navigation: { toggleDrawer: jest.fn() } })
      : (screenOptions as Record<string, unknown>);
    drawerScreenListeners = screenListeners;
    return React.createElement(React.Fragment, null, children);
  }
  Drawer.Screen = ({ name, options }: { name: string; options?: Record<string, unknown> }) => {
    registeredScreens.push({ name, options });
    return null;
  };
  return {
    Drawer,
    DrawerContentScrollView: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import DrawerLayout from "../app/(drawer)/_layout";
import { DrawerContent } from "../components/shell/DrawerContent";

function chatRecord(overrides: Partial<CanonicalChatRecord["chat"]> & { id: string }): CanonicalChatRecord {
  return {
    chat: {
      id: overrides.id,
      ownerScope: { type: "personal", ownerId: "user_123" },
      title: overrides.title ?? "",
      lifecycle: "active",
      attention: "none",
      revision: 1,
      messageCount: 1,
      lastMessagePreview: overrides.lastMessagePreview,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    } as CanonicalChatRecord["chat"],
    projectId: undefined,
  };
}

describe("authenticated drawer layout", () => {
  beforeEach(() => {
    registeredScreens.length = 0;
    drawerScreenOptions = undefined;
    drawerScreenListeners = undefined;
    jest.clearAllMocks();
    mockUseCanonicalChats.mockReturnValue({
      computer: { handle: "studio-mac" },
      chats: [
        chatRecord({ id: "chat-2", title: "Ship the mobile sidebar", updatedAt: "2026-01-02T00:00:00.000Z" }),
        chatRecord({ id: "chat-1", title: "Review the launch plan", updatedAt: "2026-01-01T00:00:00.000Z" }),
      ],
      isPending: false,
      isError: false,
    });
    mockUseProjects.mockReturnValue({ projects: [], isPending: false, isError: false });
  });

  it("plays a medium haptic when the drawer opens and closes", () => {
    render(<DrawerLayout />);
    drawerScreenListeners?.drawerOpen?.();
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
    drawerScreenListeners?.drawerClose?.();
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
  });

  it("uses chat as home and exposes the mock shell routes", () => {
    render(<DrawerLayout />);

    expect(registeredScreens.map((screen) => screen.name)).toEqual([
      "index", "files", "terminal", "integrations", "apps", "settings",
    ]);
    expect(registeredScreens.find((screen) => screen.name === "index")?.options?.title).toBeNull();
    expect(drawerScreenOptions?.drawerStyle).toMatchObject({ width: "80%" });

    const HeaderLeft = drawerScreenOptions?.headerLeft as (() => React.ReactElement) | undefined;
    render(<>{HeaderLeft?.()}</>);
    expect(screen.getByLabelText("Open navigation")).toBeTruthy();
    expect(screen.getByTestId("drawer-menu-icon")).toBeTruthy();
  });

  it("organizes the drawer as identity, primary navigation, and recent chats", () => {
    const navigate = jest.fn();
    const closeDrawer = jest.fn();
    render(
      <DrawerContent
        {...({
          state: { index: 0, routeNames: ["index", "files", "terminal", "integrations", "apps", "settings"] },
          navigation: { navigate, closeDrawer },
          descriptors: {},
          computerName: "Studio Mac",
          recentChatsLoading: false,
          recentChats: [
            chatRecord({ id: "chat-2", title: "Ship the mobile sidebar", updatedAt: "2026-01-02T00:00:00.000Z" }),
            chatRecord({ id: "chat-1", title: "Review the launch plan", updatedAt: "2026-01-01T00:00:00.000Z" }),
          ],
          projects: [],
          activeSessionId: "chat-1",
          onSelectConversation: jest.fn(),
          onNewConversation: jest.fn(),
        } as unknown as React.ComponentProps<typeof DrawerContent>)}
      />,
    );
    expect(screen.getByText("Matrix OS")).toBeTruthy();
    expect(screen.getByText("Studio Mac")).toBeTruthy();
    expect(screen.getByText("Recents")).toBeTruthy();
    expect(screen.queryByLabelText("Switch computer")).toBeNull();
    expect(screen.getByLabelText("Files")).toBeTruthy();
    expect(screen.getByLabelText("Terminal")).toBeTruthy();
    expect(screen.getByLabelText("Integrations")).toBeTruthy();
    expect(screen.getByLabelText("Apps")).toBeTruthy();
    expect(screen.queryByLabelText("Search")).toBeNull();

    expect(screen.getByText("Ship the mobile sidebar")).toBeTruthy();
    expect(screen.getByText("Review the launch plan")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Terminal"));
    expect(navigate).toHaveBeenCalledWith("terminal");
    expect(closeDrawer).toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Settings"));
    expect(navigate).toHaveBeenCalledWith("settings");

    fireEvent.press(screen.getByLabelText("New chat"));
    expect(navigate).toHaveBeenCalledWith("index");
  });

  it("shows skeleton rows while recent conversations are loading", () => {
    render(
      <DrawerContent
        {...({
          state: { index: 0, routeNames: [] },
          navigation: { navigate: jest.fn(), closeDrawer: jest.fn() },
          descriptors: {},
          computerName: "Studio Mac",
          recentChats: [],
          recentChatsLoading: true,
          projects: [],
          activeSessionId: null,
          onSelectConversation: jest.fn(),
          onNewConversation: jest.fn(),
        } as unknown as React.ComponentProps<typeof DrawerContent>)}
      />,
    );
    expect(screen.getAllByTestId("recent-chat-skeleton-row")).toHaveLength(3);
    expect(screen.queryByLabelText(/Open recent chat/)).toBeNull();
  });
});
