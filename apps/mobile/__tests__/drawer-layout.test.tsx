import type { CanonicalChatRecord } from "@matrix-os/contracts";

const registeredScreens: Array<{ name: string; options?: Record<string, unknown> }> = [];
let drawerScreenOptions: Record<string, unknown> | undefined;
let drawerScreenListeners: Record<string, () => void> | undefined;
let mockSegments: string[] = [];
const mockNavigate = jest.fn();
const mockCloseDrawer = jest.fn();

const mockUseCanonicalChats = jest.fn();
const mockUseProjects = jest.fn();
const mockSelectChat = jest.fn();
const mockStartDraftChat = jest.fn();
const mockUseSettingsSystemInfo = jest.fn();
const mockFetchCollaborationInbox = jest.fn(async () => ({ items: [] }));

jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ getToken: async () => "clerk-token" }) }));
jest.mock("@/lib/requests/collaboration", () => ({
  fetchCollaborationInbox: () => mockFetchCollaborationInbox(),
}));

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

jest.mock("@/lib/queries/use-settings-system-info", () => ({
  useSettingsSystemInfo: () => mockUseSettingsSystemInfo(),
}));

jest.mock("expo-router", () => ({ useSegments: () => mockSegments }));

jest.mock("expo-router/drawer", () => {
  const React = require("react");
  function Drawer({ children, screenOptions, screenListeners, drawerContent }: {
    children: React.ReactNode;
    screenOptions?: unknown;
    screenListeners?: Record<string, () => void>;
    drawerContent?: (props: unknown) => React.ReactNode;
  }) {
    drawerScreenOptions = typeof screenOptions === "function"
      ? screenOptions({ navigation: { toggleDrawer: jest.fn() } })
      : (screenOptions as Record<string, unknown>);
    drawerScreenListeners = screenListeners;
    return React.createElement(
      React.Fragment,
      null,
      drawerContent?.({
        state: { index: 0, routeNames: ["(tabs)"] },
        navigation: { navigate: mockNavigate, closeDrawer: mockCloseDrawer },
        descriptors: {},
      }),
      children,
    );
  }
  Drawer.Screen = function Screen({ name, options }: { name: string; options?: Record<string, unknown> }) {
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
import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import { Alert, StyleSheet as NativeStyleSheet } from "react-native";
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

const CHAT_SCREEN_SEGMENTS = ["(drawer)", "(tabs)", "(chats)"];
const SHOW_CHAT_SCREEN = ["(tabs)", { screen: "(chats)", params: { screen: "index" } }];
const SHOW_SHARED_SCREEN = ["(tabs)", { screen: "(chats)", params: { screen: "shared" } }];

describe("authenticated drawer layout", () => {
  it("copies a recent chat ID from its native long-press menu", () => {
    const alert = jest.spyOn(Alert, "alert");
    render(<DrawerContent {...({
      state: { index: 0, routeNames: ["(tabs)"] }, navigation: { navigate: jest.fn(), closeDrawer: jest.fn() }, descriptors: {},
      computerName: "Computer", recentChatsLoading: false, projects: [], activeSessionId: null,
      chatScreenFocused: true, collaborationEnabled: false,
      recentChats: [chatRecord({ id: "chat_native_list", title: "Investigate run" })],
      onSelectConversation: jest.fn(), onNewConversation: jest.fn(),
    } as unknown as React.ComponentProps<typeof DrawerContent>)} />);
    fireEvent(screen.getByLabelText("Open recent chat Investigate run"), "longPress");
    const action = alert.mock.calls[0]?.[2]?.find((button) => button.text === "Copy chat ID");
    expect(action).toBeDefined();
    action!.onPress?.();
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("chat_native_list");
    alert.mockRestore();
  });

  beforeEach(() => {
    registeredScreens.length = 0;
    drawerScreenOptions = undefined;
    drawerScreenListeners = undefined;
    mockSegments = CHAT_SCREEN_SEGMENTS;
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
    mockUseSettingsSystemInfo.mockReturnValue({ systemInfo: undefined });
  });

  it("shows shared navigation only when the computer advertises collaboration", () => {
    render(<DrawerLayout />);
    expect(screen.queryByLabelText(/Shared with me/)).toBeNull();
    cleanup();

    mockUseSettingsSystemInfo.mockReturnValue({ systemInfo: { capabilities: { collaboration: true } } });
    render(<DrawerLayout />);
    fireEvent.press(screen.getByLabelText("Shared with me"));
    expect(mockNavigate).toHaveBeenCalledWith(...SHOW_SHARED_SCREEN);
    expect(mockCloseDrawer).toHaveBeenCalled();
  });

  it("plays a medium haptic when the drawer opens and closes", () => {
    render(<DrawerLayout />);
    drawerScreenListeners?.drawerOpen?.();
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
    drawerScreenListeners?.drawerClose?.();
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
  });

  it("holds the tabs as its only screen, as a headerless side panel", () => {
    render(<DrawerLayout />);

    expect(registeredScreens.map((registered) => registered.name)).toEqual(["(tabs)"]);
    expect(drawerScreenOptions).toMatchObject({
      headerShown: false,
      drawerType: "slide",
      drawerPosition: "left",
      swipeEdgeWidth: 800,
    });
    expect(drawerScreenOptions?.drawerStyle).toMatchObject({ width: "80%" });
    expect(drawerScreenOptions?.headerLeft).toBeUndefined();
  });

  it("opens by swipe only while the chat screen is focused", () => {
    render(<DrawerLayout />);
    expect(drawerScreenOptions?.swipeEnabled).toBe(true);

    for (const segments of [
      ["(drawer)", "(tabs)", "(chats)", "shared"],
      ["(drawer)", "(tabs)", "agents"],
      ["(drawer)", "(tabs)", "(apps)", "apps"],
      ["(drawer)", "(tabs)", "(apps)", "files"],
      ["(drawer)", "(tabs)", "terminal"],
      ["(drawer)", "(tabs)", "settings"],
      ["file-browser"],
      [],
    ]) {
      cleanup();
      mockSegments = segments;
      render(<DrawerLayout />);
      expect(drawerScreenOptions?.swipeEnabled).toBe(false);
    }
  });

  it("marks the open chat as selected only while the chat screen is focused", () => {
    render(<DrawerLayout />);
    expect(screen.getByLabelText("Open recent chat Review the launch plan").props.accessibilityState)
      .toMatchObject({ selected: true });
    expect(screen.getByLabelText("Open recent chat Ship the mobile sidebar").props.accessibilityState)
      .toMatchObject({ selected: false });
    cleanup();

    mockSegments = ["(drawer)", "(tabs)", "settings"];
    render(<DrawerLayout />);
    expect(screen.getByLabelText("Open recent chat Review the launch plan").props.accessibilityState)
      .toMatchObject({ selected: false });
  });

  it("organizes the drawer as identity, shared with me, and recent chats", () => {
    const navigate = jest.fn();
    const closeDrawer = jest.fn();
    const selectConversation = jest.fn();
    const newConversation = jest.fn();
    render(
      <DrawerContent
        {...({
          state: { index: 0, routeNames: ["(tabs)"] },
          navigation: { navigate, closeDrawer },
          descriptors: {},
          computerName: "Studio Mac",
          chatScreenFocused: true,
          collaborationEnabled: true,
          pendingInvitationCount: 3,
          recentChatsLoading: false,
          recentChats: [
            chatRecord({ id: "chat-2", title: "Ship the mobile sidebar", updatedAt: "2026-01-02T00:00:00.000Z" }),
            chatRecord({ id: "chat-1", title: "Review the launch plan", updatedAt: "2026-01-01T00:00:00.000Z" }),
          ],
          projects: [],
          activeSessionId: "chat-1",
          onSelectConversation: selectConversation,
          onNewConversation: newConversation,
        } as unknown as React.ComponentProps<typeof DrawerContent>)}
      />,
    );
    expect(screen.getByText("Matrix OS")).toBeTruthy();
    expect(screen.getByText("Studio Mac")).toBeTruthy();
    expect(screen.getByText("Recents")).toBeTruthy();
    expect(screen.queryByLabelText("Switch computer")).toBeNull();
    // The other destinations are tabs now.
    for (const label of ["Files", "Terminal", "Connect Apps", "Apps", "Settings"]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    expect(screen.getByLabelText("Shared with me, 3 pending invitations")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.queryByLabelText("Search")).toBeNull();

    expect(screen.getByText("Ship the mobile sidebar")).toBeTruthy();
    expect(screen.getByText("Review the launch plan")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Shared with me, 3 pending invitations"));
    expect(navigate).toHaveBeenLastCalledWith(...SHOW_SHARED_SCREEN);
    expect(closeDrawer).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByLabelText("Open recent chat Ship the mobile sidebar"));
    expect(selectConversation).toHaveBeenCalledWith("chat-2");
    expect(navigate).toHaveBeenLastCalledWith(...SHOW_CHAT_SCREEN);
    expect(closeDrawer).toHaveBeenCalledTimes(2);

    fireEvent.press(screen.getByLabelText("New chat"));
    expect(newConversation).toHaveBeenCalled();
    expect(navigate).toHaveBeenLastCalledWith(...SHOW_CHAT_SCREEN);
    expect(closeDrawer).toHaveBeenCalledTimes(3);

    fireEvent.press(screen.getByLabelText("Open Matrix OS home"));
    expect(navigate).toHaveBeenLastCalledWith(...SHOW_CHAT_SCREEN);

    // React Navigation ignores a params object it has already acted on, so
    // each press has to hand it a new one.
    const [chatCall, newChatCall] = navigate.mock.calls.slice(1, 3);
    expect(chatCall[1]).not.toBe(newChatCall[1]);
    expect(chatCall[1].params).not.toBe(newChatCall[1].params);
  });

  it("lists Shared with me first, under the header and above the projects", () => {
    render(
      <DrawerContent
        {...({
          state: { index: 0, routeNames: ["(tabs)"] },
          navigation: { navigate: jest.fn(), closeDrawer: jest.fn() },
          descriptors: {},
          computerName: "Studio Mac",
          chatScreenFocused: true,
          collaborationEnabled: true,
          recentChatsLoading: false,
          recentChats: [],
          projects: [{ id: "project-1", name: "Portfolio" }],
          activeSessionId: null,
          onSelectConversation: jest.fn(),
          onNewConversation: jest.fn(),
        } as unknown as React.ComponentProps<typeof DrawerContent>)}
      />,
    );
    const labels = screen.getAllByRole("button").map((button) => button.props.accessibilityLabel);
    expect(labels.slice(0, 3)).toEqual(["Open Matrix OS home", "Shared with me", "Portfolio project"]);
  });

  it("leaves Shared with me out when collaboration is off", () => {
    render(
      <DrawerContent
        {...({
          state: { index: 0, routeNames: ["(tabs)"] },
          navigation: { navigate: jest.fn(), closeDrawer: jest.fn() },
          descriptors: {},
          computerName: "Studio Mac",
          chatScreenFocused: true,
          collaborationEnabled: false,
          pendingInvitationCount: 3,
          recentChatsLoading: false,
          recentChats: [],
          projects: [],
          activeSessionId: null,
          onSelectConversation: jest.fn(),
          onNewConversation: jest.fn(),
        } as unknown as React.ComponentProps<typeof DrawerContent>)}
      />,
    );
    expect(screen.queryByLabelText(/Shared with me/)).toBeNull();
    expect(screen.queryByTestId("drawer-primary-row-shared")).toBeNull();
  });

  it("left-aligns the Shared with me row", () => {
    render(
      <DrawerContent
        {...({
          state: { index: 0, routeNames: ["(tabs)"] },
          navigation: { navigate: jest.fn(), closeDrawer: jest.fn() },
          descriptors: {},
          computerName: "Studio Mac",
          chatScreenFocused: true,
          collaborationEnabled: true,
          pendingInvitationCount: 3,
          recentChatsLoading: false,
          recentChats: [],
          projects: [],
          activeSessionId: null,
          onSelectConversation: jest.fn(),
          onNewConversation: jest.fn(),
        } as unknown as React.ComponentProps<typeof DrawerContent>)}
      />,
    );
    // The button stacks its vertical Spacers around the row. Laid out as a
    // row itself, those Spacers become flex items on either side of the
    // label and `space-between` pushes the label to the center.
    const button = NativeStyleSheet.flatten(
      screen.getByLabelText("Shared with me, 3 pending invitations").props.style,
    );
    expect(button.flexDirection).not.toBe("row");
    expect(button.justifyContent).toBeUndefined();
    // The pending-invitation badge still sits at the row's trailing edge.
    const badgeRow = NativeStyleSheet.flatten(screen.getByTestId("drawer-primary-row-shared").props.style);
    expect(badgeRow).toMatchObject({ flexDirection: "row", justifyContent: "space-between" });
  });

  it("shows skeleton rows while recent conversations are loading", () => {
    render(
      <DrawerContent
        {...({
          state: { index: 0, routeNames: ["(tabs)"] },
          navigation: { navigate: jest.fn(), closeDrawer: jest.fn() },
          descriptors: {},
          computerName: "Studio Mac",
          chatScreenFocused: true,
          collaborationEnabled: false,
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
