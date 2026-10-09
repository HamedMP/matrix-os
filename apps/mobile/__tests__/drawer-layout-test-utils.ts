import { Fragment, createElement, type ReactNode } from "react";

import { C2_CHATS } from "./side-panel-test-utils";

// Shared by the suites that render app/(drawer)/_layout.tsx. Each suite mocks
// the layout's modules itself (jest.mock is per file) and points them here.

/** What the layout gave the navigator, and the route the app is on. */
export type DrawerState = {
  history: ({ type: "drawer"; status: "open" | "closed" } | { type: "route"; key: string })[];
  default?: "open" | "closed";
};
type DrawerListeners = Record<string, (event: { data: { state: DrawerState } }) => void>;

export const drawer = {
  screens: [] as string[],
  options: undefined as Record<string, unknown> | undefined,
  listeners: undefined as DrawerListeners | undefined,
  /** The navigator state the layout reads when it sets up its listeners. */
  state: { history: [] } as DrawerState,
  segments: [] as string[],
  /** What `useDrawerStatus` reports. */
  status: "closed" as "open" | "closed",
};

export const mocks = {
  navigate: jest.fn(),
  closeDrawer: jest.fn(),
  useCanonicalChatPages: jest.fn(),
  useProjects: jest.fn(),
  useAgents: jest.fn(),
  useAgentStatuses: jest.fn(),
  useChatSearch: jest.fn(),
  selectChat: jest.fn(),
  startDraftChat: jest.fn(),
  useSettingsSystemInfo: jest.fn(),
  fetchCollaborationInbox: jest.fn(),
};

interface DrawerProps {
  children: ReactNode;
  screenOptions?: Record<string, unknown>;
  screenListeners?: (props: { navigation: { getState: () => DrawerState } }) => DrawerListeners;
  drawerContent?: (props: unknown) => ReactNode;
}

/** Stands in for `expo-router/drawer`: records the navigator's props and renders the panel. */
export function drawerModule() {
  function Drawer({ children, screenOptions, screenListeners, drawerContent }: DrawerProps) {
    drawer.options = screenOptions;
    drawer.listeners = screenListeners?.({ navigation: { getState: () => drawer.state } });
    return createElement(
      Fragment,
      null,
      drawerContent?.({
        state: { index: 0, routeNames: ["(tabs)"] },
        navigation: { navigate: mocks.navigate, closeDrawer: mocks.closeDrawer },
        descriptors: {},
      }),
      children,
    );
  }
  Drawer.Screen = function Screen({ name }: { name: string }) {
    drawer.screens.push(name);
    return null;
  };
  return {
    Drawer,
    useDrawerStatus: () => drawer.status,
    getDrawerStatusFromState: jest.requireActual(
      "expo-router/build/react-navigation/drawer/utils/getDrawerStatusFromState",
    ).getDrawerStatusFromState,
  };
}

export const CHAT_SCREEN_SEGMENTS = ["(drawer)", "(tabs)", "(chats)"];

/** What `useCanonicalChatPages` returns: frame C2's chats, all loaded. */
export function chatPages(overrides: Record<string, unknown> = {}) {
  return {
    chats: C2_CHATS,
    isPending: false,
    isError: false,
    hasMore: false,
    loadMore: jest.fn(async () => undefined),
    isLoadingMore: false,
    isLoadMoreError: false,
    ...overrides,
  };
}

/** The chat screen of a computer with frame C2's chats, three projects, no agents and no collaboration. */
export function resetDrawerLayout() {
  jest.clearAllMocks();
  drawer.screens.length = 0;
  drawer.options = undefined;
  drawer.listeners = undefined;
  drawer.state = { history: [] };
  drawer.segments = CHAT_SCREEN_SEGMENTS;
  drawer.status = "closed";
  mocks.useCanonicalChatPages.mockReturnValue(chatPages());
  mocks.useProjects.mockReturnValue({
    projects: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
    isPending: false,
    isError: false,
  });
  mocks.useAgents.mockReturnValue({ agents: [] });
  mocks.useAgentStatuses.mockReturnValue({ statuses: {} });
  mocks.useChatSearch.mockReturnValue({ results: [], isSearching: false, isError: false });
  mocks.useSettingsSystemInfo.mockReturnValue({ systemInfo: undefined });
  mocks.fetchCollaborationInbox.mockResolvedValue({ items: [] });
}
