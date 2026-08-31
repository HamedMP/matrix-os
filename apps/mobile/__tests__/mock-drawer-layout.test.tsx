const registeredScreens: Array<{ name: string; options?: Record<string, unknown> }> = [];
let drawerScreenOptions: Record<string, unknown> | undefined;
let drawerScreenListeners: Record<string, () => void> | undefined;
let mockActiveComputerQueryOptions: Record<string, unknown> | undefined;
let mockConversationsQueryOptions: Record<string, unknown> | undefined;

const mockGetToken = jest.fn().mockResolvedValue("clerk-token");
const mockFetchActiveComputer = jest.fn();
const mockFetchConversations = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ getToken: mockGetToken, isLoaded: true, isSignedIn: true, userId: "user_123" }),
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: (options: Record<string, unknown>) => {
    const queryKey = options.queryKey as string[];
    if (queryKey.includes("conversations")) {
      mockConversationsQueryOptions = options;
      return {
        data: [
          { id: "chat-2", preview: "Ship the mobile sidebar", updatedAt: 20 },
          { id: "chat-1", preview: "Review the launch plan", updatedAt: 10 },
        ],
      };
    }
    mockActiveComputerQueryOptions = options;
    return { data: { handle: "studio-mac", runtimeSlot: "primary", gatewayPath: "/vm/studio-mac" } };
  },
}));

jest.mock("@/lib/requests", () => ({
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  fetchConversations: (...args: unknown[]) => mockFetchConversations(...args),
  mobileQueryKeys: {
    activeComputer: (userId: string) => ["mobile", "computers", "active", userId],
    conversations: (userId: string, computerKey: string) => [
      "mobile",
      "conversations",
      userId,
      computerKey,
    ],
  },
}));

jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
}));

jest.mock("expo-router/drawer", () => {
  const React = require("react");
  function Drawer({ children, screenOptions, screenListeners }: {
    children: React.ReactNode;
    screenOptions?: Record<string, unknown> | ((props: Record<string, unknown>) => Record<string, unknown>);
    screenListeners?: Record<string, () => void>;
  }) {
    drawerScreenOptions = typeof screenOptions === "function"
      ? screenOptions({ navigation: { toggleDrawer: jest.fn() } })
      : screenOptions;
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
import { StyleSheet as NativeStyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import DrawerLayout from "../app/(drawer)/_layout";
import { MockDrawerContent } from "../components/mock-shell/MockDrawerContent";

describe("authenticated drawer layout", () => {
  beforeEach(() => {
    registeredScreens.length = 0;
    drawerScreenOptions = undefined;
    drawerScreenListeners = undefined;
    mockActiveComputerQueryOptions = undefined;
    mockConversationsQueryOptions = undefined;
    mockGetToken.mockClear();
    mockFetchActiveComputer.mockClear();
    mockFetchConversations.mockClear();
    jest.clearAllMocks();
  });

  it("plays a medium haptic when the drawer opens and closes", () => {
    render(<DrawerLayout />);

    drawerScreenListeners?.drawerOpen?.();
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);

    drawerScreenListeners?.drawerClose?.();
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
  });

  it("uses chat as home, loads the active computer, and exposes the mock shell routes", async () => {
    render(<DrawerLayout />);

    expect(registeredScreens.map((screen) => screen.name)).toEqual([
      "index",
      "search",
      "files",
      "terminal",
      "integrations",
      "apps",
      "settings",
    ]);
    expect(registeredScreens.find((screen) => screen.name === "index")?.options?.title).toBeNull();
    expect(drawerScreenOptions?.drawerStyle).toMatchObject({ width: "80%" });
    expect(mockActiveComputerQueryOptions).toMatchObject({
      enabled: true,
      queryKey: ["mobile", "computers", "active", "user_123"],
    });

    mockFetchActiveComputer.mockResolvedValue({ handle: "studio-mac" });
    const queryFn = mockActiveComputerQueryOptions?.queryFn as (() => Promise<unknown>) | undefined;
    await expect(queryFn?.()).resolves.toEqual({ handle: "studio-mac" });
    expect(mockFetchActiveComputer).toHaveBeenCalledWith("clerk-token");
    expect(mockConversationsQueryOptions).toMatchObject({
      enabled: true,
      queryKey: ["mobile", "conversations", "user_123", "studio-mac:primary"],
    });

    mockFetchConversations.mockResolvedValue([]);
    const conversationsQueryFn = mockConversationsQueryOptions?.queryFn as (() => Promise<unknown>) | undefined;
    await expect(conversationsQueryFn?.()).resolves.toEqual([]);
    expect(mockFetchConversations).toHaveBeenCalledWith(
      "clerk-token",
      "https://app.matrix-os.com/vm/studio-mac",
    );
    const selectConversations = mockConversationsQueryOptions?.select as (
      items: Array<{ id: string; updatedAt: number }>,
    ) => Array<{ id: string; updatedAt: number }>;
    expect(selectConversations([
      { id: "chat-1", updatedAt: 1 },
      { id: "chat-2", updatedAt: 2 },
      { id: "chat-3", updatedAt: 3 },
      { id: "chat-4", updatedAt: 4 },
      { id: "chat-5", updatedAt: 5 },
    ]).map((chat) => chat.id)).toEqual([
      "chat-5",
      "chat-4",
      "chat-3",
      "chat-2",
      "chat-1",
    ]);

    const HeaderLeft = drawerScreenOptions?.headerLeft as (() => React.ReactNode) | undefined;
    render(<>{HeaderLeft?.()}</>);
    expect(screen.getByLabelText("Open navigation")).toBeTruthy();
    expect(screen.getByTestId("drawer-menu-icon").props.color).toBe("#242323");
  });

  it("organizes the drawer as identity, natural-height navigation, and recent chats", () => {
    const navigate = jest.fn();
    const closeDrawer = jest.fn();

    render(
      <MockDrawerContent
        {...({
          state: {
            index: 0,
            routeNames: ["index", "search", "files", "terminal", "integrations", "apps", "settings"],
          },
          navigation: { navigate, closeDrawer },
          descriptors: {},
          computerName: "Studio Mac",
          recentChatsLoading: false,
          recentChats: [
            { id: "chat-2", preview: "Ship the mobile sidebar", updatedAt: 20 },
            { id: "chat-1", preview: "Review the launch plan", updatedAt: 10 },
          ],
        } as never)}
      />,
    );

    expect(screen.getByText("Matrix OS")).toBeTruthy();
    expect(screen.getByText("Studio Mac")).toBeTruthy();
    expect(screen.getByText("RECENTS")).toBeTruthy();
    expect(screen.queryByLabelText("Switch computer")).toBeNull();

    const filesStyle = NativeStyleSheet.flatten(screen.getByLabelText("Files").props.style);
    expect(filesStyle).toMatchObject({ borderWidth: 1 });
    expect(filesStyle.marginHorizontal).toBeUndefined();
    expect(filesStyle.height).toBeUndefined();
    expect(filesStyle.minHeight).toBeUndefined();

    const recentStyle = NativeStyleSheet.flatten(
      screen.getByLabelText("Open recent chat Ship the mobile sidebar").props.style,
    );
    expect(recentStyle).toMatchObject({ borderWidth: 1 });
    expect(recentStyle.height).toBeUndefined();
    expect(recentStyle.minHeight).toBeUndefined();

    const recentsTitleStyle = NativeStyleSheet.flatten(screen.getByText("RECENTS").props.style);
    expect(recentsTitleStyle.paddingHorizontal).toBe(0);

    const newChatStyle = NativeStyleSheet.flatten(screen.getByLabelText("New chat").props.style);
    expect(newChatStyle).toMatchObject({
      position: "absolute",
      left: 16,
      bottom: 24,
      backgroundColor: "#2B3715",
      boxShadow: "0 8px 16px rgba(51, 46, 36, 0.10)",
    });
    expect(screen.getByTestId("new-chat-icon")).toBeTruthy();

    const settingsStyle = NativeStyleSheet.flatten(screen.getByLabelText("Settings").props.style);
    expect(settingsStyle).toMatchObject({
      position: "absolute",
      right: 16,
      bottom: 26,
      backgroundColor: "transparent",
      borderWidth: 1,
      borderRadius: 999,
      width: 40,
      height: 40,
      boxShadow: "0 8px 16px rgba(51, 46, 36, 0.10)",
    });
    expect(screen.getByTestId("settings-icon")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Search"));
    expect(navigate).toHaveBeenCalledWith("search");
    expect(closeDrawer).toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Settings"));
    expect(navigate).toHaveBeenCalledWith("settings");
  });

  it("shows skeleton rows while recent conversations are loading", () => {
    render(
      <MockDrawerContent
        {...({
          state: { index: 0, routeNames: [] },
          navigation: { navigate: jest.fn(), closeDrawer: jest.fn() },
          descriptors: {},
          computerName: "Studio Mac",
          recentChats: [],
          recentChatsLoading: true,
        } as never)}
      />,
    );

    expect(screen.getAllByTestId("recent-chat-skeleton-row")).toHaveLength(3);
    expect(screen.queryByLabelText(/Open recent chat/)).toBeNull();
  });
});
