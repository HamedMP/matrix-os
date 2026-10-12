import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { TABS, TabBar } from "../components/shell/TabBar";
import { Icon } from "../components/ui/Icon";
import {
  AgentsTabIcon,
  AppsTabIcon,
  ChatsTabIcon,
  SettingsTabIcon,
  TerminalTabIcon,
} from "../components/ui/icons";

import { flat, pressedStyle } from "./ui-test-utils";

function renderBar(props: Partial<React.ComponentProps<typeof TabBar>> = {}, bottomInset = 34) {
  const onTabPress = jest.fn();
  render(
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: bottomInset, left: 0 }}>
      <TabBar testID="tab-bar" activeRoute="(chats)" onTabPress={onTabPress} {...props} />
    </SafeAreaInsetsContext.Provider>,
  );
  return onTabPress;
}

describe("TabBar", () => {
  afterEach(cleanup);

  it("shows Chats, Agents, Apps, Terminal and Settings in that order, each with its icon", () => {
    renderBar();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.props.accessibilityLabel)).toEqual([
      "Chats", "Agents", "Apps", "Terminal", "Settings",
    ]);
    expect(screen.UNSAFE_getAllByType(Icon).map((icon) => icon.props.icon)).toEqual([
      ChatsTabIcon, AgentsTabIcon, AppsTabIcon, TerminalTabIcon, SettingsTabIcon,
    ]);
    expect(TABS.map((tab) => tab.route)).toEqual(["(chats)", "agents", "(apps)", "terminal", "settings"]);
  });

  it("is a row on the background colour with a hairline on top and the device's bottom inset below", () => {
    renderBar({}, 34);

    const bar = screen.getByTestId("tab-bar");
    expect(bar.props.accessibilityRole).toBe("tablist");
    expect(flat(bar)).toMatchObject({
      flexDirection: "row",
      justifyContent: "space-between",
      paddingTop: 8,
      paddingHorizontal: 12,
      paddingBottom: 34,
      borderTopWidth: 1,
      borderTopColor: "#F3F2F2",
      backgroundColor: "#FFFEFC",
    });
    cleanup();

    renderBar({}, 0);
    expect(flat(screen.getByTestId("tab-bar")).paddingBottom).toBe(0);
  });

  it("makes each tab a centred 70pt column that is at least 44pt high and can narrow", () => {
    renderBar();

    for (const tab of screen.getAllByRole("tab")) {
      expect(flat(tab)).toMatchObject({
        width: 70,
        flexShrink: 1,
        minHeight: 44,
        alignItems: "center",
        borderRadius: 8,
      });
      expect(flat(tab).flexDirection).toBeUndefined();
    }
  });

  it("sets a 24pt icon in a padded box, 4pt above the label", () => {
    renderBar();

    const icon = screen.UNSAFE_getAllByType(Icon)[0];
    expect(icon.props.size).toBe(24);
    expect(flat(icon.parent!)).toMatchObject({
      paddingHorizontal: 14,
      paddingVertical: 2,
      marginBottom: 4,
    });
  });

  it("fills the active tab with the card colour and sets it in semibold primary text", () => {
    renderBar({ activeRoute: "agents" });

    const active = screen.getByRole("tab", { name: "Agents" });
    expect(active.props.accessibilityState).toMatchObject({ selected: true });
    expect(flat(active).backgroundColor).toBe("#FAF9F7");
    expect(flat(screen.getByText("Agents"))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 11,
      lineHeight: 15,
      color: "#242323",
    });
    expect(screen.UNSAFE_getAllByType(Icon)[1].props.color).toBe("#242323");
  });

  it("leaves the other tabs unfilled, in medium secondary text", () => {
    renderBar({ activeRoute: "agents" });

    const inactive = screen.getByRole("tab", { name: "Chats" });
    expect(inactive.props.accessibilityState).toMatchObject({ selected: false });
    expect(flat(inactive).backgroundColor).toBeUndefined();
    const label = screen.getByText("Chats");
    expect(flat(label)).toMatchObject({
      fontFamily: "Geist_500Medium",
      fontSize: 11,
      lineHeight: 15,
      color: "#635F5F",
    });
    expect(label.props.numberOfLines).toBe(1);
    expect(screen.UNSAFE_getAllByType(Icon)[0].props.color).toBe("#635F5F");
  });

  it("marks exactly one tab as selected", () => {
    renderBar({ activeRoute: "(apps)" });

    const selected = screen.getAllByRole("tab").filter((tab) => tab.props.accessibilityState.selected);
    expect(selected.map((tab) => tab.props.accessibilityLabel)).toEqual(["Apps"]);
  });

  it("shows no badge while no agent is waiting", () => {
    renderBar();
    expect(screen.queryByTestId("tab-badge-agents")).toBeNull();
    cleanup();

    renderBar({ agentsBadgeCount: 0 });
    expect(screen.queryByTestId("tab-badge-agents")).toBeNull();
    expect(screen.getByRole("tab", { name: "Agents" })).toBeTruthy();
  });

  it("puts a ringed count over the Agents icon's top right corner and says it in the tab's name", () => {
    renderBar({ agentsBadgeCount: 2 });

    expect(screen.getByText("2")).toBeTruthy();
    expect(flat(screen.getByTestId("tab-badge-agents-count"))).toMatchObject({
      borderWidth: 1.5,
      borderColor: "#FFFEFC",
      backgroundColor: "#E0AA52",
    });
    expect(flat(screen.getByTestId("tab-badge-agents"))).toMatchObject({ position: "absolute", top: -2, right: 4 });
    expect(screen.getByRole("tab", { name: "Agents, 2 waiting" })).toBeTruthy();
    // Only the Agents tab carries the count.
    for (const route of ["(chats)", "(apps)", "terminal", "settings"]) {
      expect(screen.queryByTestId(`tab-badge-${route}`)).toBeNull();
    }
  });

  it("reports the pressed tab's route", () => {
    const onTabPress = renderBar();

    fireEvent.press(screen.getByRole("tab", { name: "Terminal" }));
    expect(onTabPress).toHaveBeenLastCalledWith("terminal");
    fireEvent.press(screen.getByRole("tab", { name: "Apps" }));
    expect(onTabPress).toHaveBeenLastCalledWith("(apps)");
    // Pressing the tab already on screen is reported too: its stack returns to its first screen.
    fireEvent.press(screen.getByRole("tab", { name: "Chats" }));
    expect(onTabPress).toHaveBeenLastCalledWith("(chats)");
    expect(onTabPress).toHaveBeenCalledTimes(3);
  });

  it("reports a long press when asked to", () => {
    const onTabLongPress = jest.fn();
    renderBar({ onTabLongPress });

    fireEvent(screen.getByRole("tab", { name: "Settings" }), "longPress");
    expect(onTabLongPress).toHaveBeenCalledWith("settings");
  });

  it("dims a tab to 0.65 while it is pressed", () => {
    renderBar();

    expect(pressedStyle({ accessibilityLabel: "Agents" }).opacity).toBe(0.65);
  });
});
