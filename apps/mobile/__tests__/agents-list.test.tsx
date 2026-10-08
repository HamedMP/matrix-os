import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { AgentsListScreen, type AgentsListScreenProps } from "../components/agents/AgentsListScreen";
import type { AgentListRow } from "../components/agents/agent-rows";
import { AgentMascot } from "../components/ui/AgentMascot";
import { EmptyState } from "../components/ui/EmptyState";
import { Icon } from "../components/ui/Icon";
import { AddIcon } from "../components/ui/icons";
import { StatusDot } from "../components/ui/StatusDot";

import { flat } from "./ui-test-utils";

const rows: AgentListRow[] = [
  { id: "bot_research", name: "Account research", tone: "waiting", subtitle: "Waiting for your approval", time: "2m" },
  { id: "bot_inbox", name: "My inbox", tone: "active", subtitle: "Working", time: "1h" },
  { id: "bot_launch", name: "Launch tracker", category: "operations", tone: null, subtitle: "Keeps the launch on track", time: "" },
  { id: "bot_plain", name: "Untitled helper", tone: null, time: "Mon" },
];

function renderList(overrides: Partial<AgentsListScreenProps> = {}) {
  const props: AgentsListScreenProps = {
    state: "ready",
    rows,
    refreshing: false,
    onRefresh: jest.fn(),
    onRetry: jest.fn(),
    onNewAgent: jest.fn(),
    onOpenAgent: jest.fn(),
    ...overrides,
  };
  render(
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
      <AgentsListScreen {...props} />
    </SafeAreaInsetsContext.Provider>,
  );
  return props;
}

describe("agents list screen", () => {
  afterEach(cleanup);

  it("starts below the status bar on the background colour, with no top bar", () => {
    renderList();

    expect(flat(screen.getByTestId("agents-screen"))).toMatchObject({ paddingTop: 62, backgroundColor: "#FFFEFC" });
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("heads the screen with the Agents title and New agent, 8pt down, 20pt in and 20pt above the list", () => {
    renderList();

    expect(flat(screen.getByTestId("agents-header"))).toMatchObject({
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 8,
      marginHorizontal: 20,
      marginBottom: 20,
    });
    expect(flat(screen.getByRole("header", { name: "Agents" }))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 30,
      lineHeight: 41,
      color: "#242323",
    });
  });

  it("offers New agent as a secondary button with the add icon", () => {
    const { onNewAgent } = renderList();

    const button = screen.getByTestId("agents-new");
    expect(button.props.accessibilityRole).toBe("button");
    expect(button.props.accessibilityLabel).toBe("New agent");
    expect(flat(button)).toMatchObject({ height: 44, backgroundColor: "#F5F5F5" });
    expect(within(button).UNSAFE_getByType(Icon).props.icon).toBe(AddIcon);

    fireEvent.press(button);
    expect(onNewAgent).toHaveBeenCalledTimes(1);
  });

  it("lists the agents 20pt in and 4pt apart", () => {
    renderList();

    expect(flat({ props: { style: screen.getByTestId("agents-list").props.contentContainerStyle } })).toMatchObject({
      paddingHorizontal: 20,
      gap: 4,
    });
    expect(screen.getAllByTestId(/^agent-row-[a-z_]+$/)).toHaveLength(4);
  });

  it("draws each agent as a compact row with its 36pt mascot", () => {
    renderList();

    const row = screen.getByTestId("agent-row-bot_launch");
    expect(flat(row).paddingVertical).toBe(10);
    const mascot = within(row).UNSAFE_getByType(AgentMascot);
    expect(mascot.props).toMatchObject({ id: "bot_launch", name: "Launch tracker", category: "operations" });
    expect(flat(within(row).getByRole("image", { name: "Launch tracker" }))).toMatchObject({ width: 36, height: 36 });
    expect(within(row).getByText("Launch tracker")).toBeTruthy();
    expect(within(row).getByText("Keeps the launch on track")).toBeTruthy();
  });

  it("puts a waiting dot after an agent that needs the person and an active dot after a working one", () => {
    renderList();

    expect(within(screen.getByTestId("agent-row-bot_research")).UNSAFE_getByType(StatusDot).props.tone).toBe("waiting");
    expect(flat(screen.getByTestId("agent-dot-bot_research")).backgroundColor).toBe("#E0AA52");
    expect(within(screen.getByTestId("agent-row-bot_inbox")).UNSAFE_getByType(StatusDot).props.tone).toBe("active");
    expect(flat(screen.getByTestId("agent-dot-bot_inbox")).backgroundColor).toBe("#288A5B");
    expect(within(screen.getByTestId("agent-row-bot_launch")).UNSAFE_queryByType(StatusDot)).toBeNull();
  });

  it("shows the last activity time at the top right, and nothing when it is unknown", () => {
    renderList();

    expect(flat(within(screen.getByTestId("agent-row-bot_research")).getByText("2m"))).toMatchObject({
      fontSize: 12,
      lineHeight: 17,
      color: "#8A8686",
      alignSelf: "flex-start",
    });
    expect(within(screen.getByTestId("agent-row-bot_plain")).getByText("Mon")).toBeTruthy();
    expect(within(screen.getByTestId("agent-row-bot_launch")).queryByText(/^(now|\d+[mh]|Mon)$/)).toBeNull();
  });

  it("leaves the second line out for an agent with nothing to say", () => {
    renderList();

    const row = screen.getByTestId("agent-row-bot_plain");
    expect(within(row).getAllByText(/./).map((node) => node.props.children)).toEqual(["Untitled helper", "Mon"]);
  });

  it("opens the agent whose row is pressed", () => {
    const { onOpenAgent } = renderList();

    fireEvent.press(screen.getByTestId("agent-row-bot_inbox"));

    expect(onOpenAgent).toHaveBeenCalledWith("bot_inbox");
    expect(screen.getByTestId("agent-row-bot_inbox").props.accessibilityRole).toBe("button");
  });

  it("names each row once for a screen reader: name, status line and time, without the mascot's name again", () => {
    renderList();

    expect(screen.getByTestId("agent-row-bot_research").props.accessibilityLabel)
      .toBe("Account research, Waiting for your approval, 2m");
    expect(screen.getByTestId("agent-row-bot_launch").props.accessibilityLabel)
      .toBe("Launch tracker, Keeps the launch on track");
    expect(screen.getByTestId("agent-row-bot_plain").props.accessibilityLabel).toBe("Untitled helper, Mon");
  });

  it("reads the list again when it is pulled down", () => {
    const { onRefresh } = renderList({ refreshing: true });

    const list = screen.getByTestId("agents-list");
    expect(list.props.refreshing).toBe(true);
    fireEvent(list, "refresh");

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows the existing skeleton rows while the list loads", () => {
    renderList({ state: "loading", rows: [] });

    expect(screen.getAllByTestId("agents-skeleton-row").length).toBeGreaterThan(0);
    expect(flat(screen.getByTestId("agents-loading")).paddingHorizontal).toBe(20);
    expect(screen.queryByTestId("agents-list")).toBeNull();
    expect(screen.getByTestId("agents-new")).toBeTruthy();
  });

  it("says so in generic words, with a retry, when the list is unavailable", () => {
    const { onRetry } = renderList({ state: "unavailable", rows: [] });

    const line = screen.getByRole("alert");
    expect(line.props.children).toBe("Agents are not available right now.");
    expect(flat(line)).toMatchObject({ fontSize: 14, lineHeight: 20, color: "#635F5F", textAlign: "center" });
    expect(screen.queryByTestId("agents-list")).toBeNull();

    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state with a New agent action when there are no agents", () => {
    const { onNewAgent } = renderList({ rows: [] });

    const empty = screen.getByTestId("agents-empty");
    expect(within(empty).UNSAFE_getByType(EmptyState).props.message).toBe("No agents yet");
    expect(screen.queryByTestId(/^agent-row-/)).toBeNull();

    const action = within(empty).getByRole("button", { name: "New agent" });
    expect(flat(action).height).toBeGreaterThanOrEqual(44);
    fireEvent.press(action);
    expect(onNewAgent).toHaveBeenCalledTimes(1);
  });

  it("draws none of the controls the server has nothing behind", () => {
    renderList();

    expect(screen.queryByText(/paused/i)).toBeNull();
    expect(screen.queryByText(/^runs\b/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /pause/i })).toBeNull();
  });
});
