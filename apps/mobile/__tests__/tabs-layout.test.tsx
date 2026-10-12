import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Platform } from "react-native";

import TabsLayout from "../app/(drawer)/(tabs)/_layout";
import { TAB_BAR_HIDDEN_ROUTES } from "../lib/tab-bar-visibility";

const registeredTabs: string[] = [];
let tabsProps: {
  tabBar?: (props: unknown) => React.ReactNode;
  screenOptions?: Record<string, unknown>;
} = {};
let mockKeyboardVisible = false;
let mockAgentsWaiting = 0;

jest.mock("expo-router/tabs", () => {
  const mockReact = jest.requireActual("react") as typeof import("react");
  function Tabs({ children, ...props }: { children: React.ReactNode }) {
    tabsProps = props;
    return mockReact.createElement(mockReact.Fragment, null, children);
  }
  Tabs.Screen = function Screen({ name }: { name: string }) {
    registeredTabs.push(name);
    return null;
  };
  return { Tabs };
});

jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => mockKeyboardVisible }));
// The real hook reads the agents of the signed-in computer.
jest.mock("@/components/agents/use-agents-waiting-count", () => ({
  useAgentsWaitingCount: () => mockAgentsWaiting,
}));

const TAB_ROUTES = ["(chats)", "agents", "(apps)", "terminal", "settings"];

interface TabRouteState {
  key: string;
  name: string;
  params?: object;
  state?: { index: number; routes: { name: string }[] };
}

function tabState(focused: string, nested: Record<string, TabRouteState["state"]> = {}) {
  const routes: TabRouteState[] = TAB_ROUTES.map((name) => ({ key: `${name}-key`, name, state: nested[name] }));
  return { index: TAB_ROUTES.indexOf(focused), routes };
}

function renderTabBar(state: ReturnType<typeof tabState>, defaultPrevented = false) {
  const navigation = {
    emit: jest.fn(() => ({ defaultPrevented })),
    navigate: jest.fn(),
  };
  render(<TabsLayout />);
  const tabBar = tabsProps.tabBar!({ state, navigation, descriptors: {}, insets: { top: 0, right: 0, bottom: 0, left: 0 } });
  cleanup();
  render(<>{tabBar}</>);
  return navigation;
}

describe("tabs layout", () => {
  const originalPlatform = Platform.OS;
  const hiddenRoutes = TAB_BAR_HIDDEN_ROUTES as Record<string, readonly string[]>;
  const realHiddenRoutes = { ...TAB_BAR_HIDDEN_ROUTES };

  beforeEach(() => {
    registeredTabs.length = 0;
    tabsProps = {};
    mockKeyboardVisible = false;
    mockAgentsWaiting = 0;
  });

  afterEach(() => {
    cleanup();
    Platform.OS = originalPlatform;
    // A test may list a screen of its own; the app's own entries come back.
    for (const key of Object.keys(hiddenRoutes)) delete hiddenRoutes[key];
    Object.assign(hiddenRoutes, realHiddenRoutes);
  });

  it("registers the five tabs in the order of the tab bar, without headers, on the background colour", () => {
    render(<TabsLayout />);

    expect(registeredTabs).toEqual(TAB_ROUTES);
    expect(tabsProps.screenOptions).toMatchObject({
      headerShown: false,
      sceneStyle: { backgroundColor: "#FFFEFC" },
    });
  });

  it("draws the tab bar with the focused tab active and no Agents badge", () => {
    renderTabBar(tabState("(apps)", { "(apps)": { index: 0, routes: [{ name: "apps" }] } }));

    expect(screen.getAllByRole("tab").map((tab) => tab.props.accessibilityLabel)).toEqual([
      "Chats", "Agents", "Apps", "Terminal", "Settings",
    ]);
    expect(screen.getByRole("tab", { name: "Apps" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole("tab", { name: "Chats" }).props.accessibilityState).toMatchObject({ selected: false });
    expect(screen.queryByTestId("tab-badge-agents")).toBeNull();
  });

  it("shows on the Agents tab how many agents are waiting on the person", () => {
    mockAgentsWaiting = 2;
    renderTabBar(tabState("(chats)"));

    expect(screen.getByRole("tab", { name: "Agents, 2 waiting" })).toBeTruthy();
    expect(screen.getByTestId("tab-badge-agents")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("drops the badge once no agent is waiting any more", () => {
    mockAgentsWaiting = 1;
    renderTabBar(tabState("agents"));
    expect(screen.getByTestId("tab-badge-agents")).toBeTruthy();
    cleanup();

    mockAgentsWaiting = 0;
    renderTabBar(tabState("agents"));
    expect(screen.queryByTestId("tab-badge-agents")).toBeNull();
    expect(screen.getByRole("tab", { name: "Agents" })).toBeTruthy();
  });

  it("switches to the pressed tab, telling its navigator first", () => {
    const state = tabState("(chats)");
    state.routes[4].params = { from: "link" };
    const navigation = renderTabBar(state);

    fireEvent.press(screen.getByRole("tab", { name: "Settings" }));

    expect(navigation.emit).toHaveBeenCalledWith({ type: "tabPress", target: "settings-key", canPreventDefault: true });
    expect(navigation.navigate).toHaveBeenCalledWith("settings", { from: "link" });
  });

  it("only tells the navigator when the pressed tab is already on screen", () => {
    const navigation = renderTabBar(tabState("(apps)"));

    fireEvent.press(screen.getByRole("tab", { name: "Apps" }));

    expect(navigation.emit).toHaveBeenCalledWith({ type: "tabPress", target: "(apps)-key", canPreventDefault: true });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("stays on the current tab when a screen prevents the press", () => {
    const navigation = renderTabBar(tabState("(chats)"), true);

    fireEvent.press(screen.getByRole("tab", { name: "Agents" }));

    expect(navigation.emit).toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("passes a long press on to the tab's navigator", () => {
    const navigation = renderTabBar(tabState("(chats)"));

    fireEvent(screen.getByRole("tab", { name: "Terminal" }), "longPress");

    expect(navigation.emit).toHaveBeenCalledWith({ type: "tabLongPress", target: "terminal-key" });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("is hidden on the New agent screen, which takes the whole display", () => {
    renderTabBar(tabState("agents", { agents: { index: 1, routes: [{ name: "index" }, { name: "new" }] } }));
    expect(screen.queryByRole("tab")).toBeNull();
    cleanup();

    // Back on the tab's first screen, and on every other tab, it returns.
    renderTabBar(tabState("agents", { agents: { index: 0, routes: [{ name: "index" }] } }));
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    cleanup();

    renderTabBar(tabState("(chats)", { agents: { index: 1, routes: [{ name: "index" }, { name: "new" }] } }));
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("is hidden on an agent's chat, and returns on the Agents list", () => {
    renderTabBar(tabState("agents", { agents: { index: 1, routes: [{ name: "index" }, { name: "[agentId]" }] } }));
    expect(screen.queryByRole("tab")).toBeNull();
    cleanup();

    renderTabBar(tabState("agents", { agents: { index: 0, routes: [{ name: "index" }] } }));
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("is hidden on any other screen listed as taking the whole display", () => {
    hiddenRoutes["(apps)"] = ["files"];

    renderTabBar(tabState("(apps)", { "(apps)": { index: 1, routes: [{ name: "apps" }, { name: "files" }] } }));
    expect(screen.queryByRole("tab")).toBeNull();
    cleanup();

    renderTabBar(tabState("(apps)", { "(apps)": { index: 0, routes: [{ name: "apps" }] } }));
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("gives the listed screens back to the app after a test has listed its own", () => {
    expect(TAB_BAR_HIDDEN_ROUTES).toEqual(realHiddenRoutes);
    expect(TAB_BAR_HIDDEN_ROUTES).toEqual({ agents: ["new", "[agentId]"] });
  });

  it("is hidden on Android while the keyboard is open, and returns when it closes", () => {
    Platform.OS = "android";
    mockKeyboardVisible = true;
    renderTabBar(tabState("(chats)"));
    expect(screen.queryByRole("tab")).toBeNull();
    cleanup();

    mockKeyboardVisible = false;
    renderTabBar(tabState("(chats)"));
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("stays in place on iOS while the keyboard is open, where the keyboard covers it", () => {
    Platform.OS = "ios";
    mockKeyboardVisible = true;
    renderTabBar(tabState("(chats)"));

    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });
});
