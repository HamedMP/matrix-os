import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { ActivityIndicator } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { AgentDetailsSheet, type AgentDetailsSheetProps } from "../components/agents/AgentDetailsSheet";
import { AgentMascot } from "../components/ui/AgentMascot";
import { Icon } from "../components/ui/Icon";
import { LockIcon } from "../components/ui/icons";
import { StatusDot } from "../components/ui/StatusDot";

import { flat } from "./ui-test-utils";

let mockSheet: { isPresented: boolean; onDismiss: () => void } = { isPresented: false, onDismiss: () => {} };

// Keeps its content when it is not presented, as the native sheet does while it slides away.
jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean; onDismiss: () => void }) => {
      mockSheet = props;
      return <View testID="expo-bottom-sheet">{props.children}</View>;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});

const agent = {
  id: "bot_research1",
  name: "Account research",
  description: "Briefs you before every sales call",
  category: "sales",
};

const authority = {
  agentId: "bot_research1",
  revision: 1,
  grants: [],
  connections: [
    { service: "web_search", state: "granted" },
    { service: "google_drive", state: "connected_not_granted" },
    { service: "google_calendar", state: "not_connected" },
  ],
  routines: [],
  pendingInteractions: [],
  memory: { items: [] },
};

function sheet(overrides: Partial<AgentDetailsSheetProps> = {}) {
  const props = {
    visible: true,
    onClose: jest.fn(),
    agent,
    authority,
    tasks: [],
    runsOn: "Runs on Pi · Claude Sonnet 5 via Matrix AI",
    actionsAvailable: true,
    onRevoke: jest.fn(async () => undefined),
    onMemory: jest.fn(async () => undefined),
    onRefresh: jest.fn(async () => undefined),
    archiving: false,
    onArchive: jest.fn(),
    ...overrides,
  } as unknown as AgentDetailsSheetProps;
  const element = (
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
      <AgentDetailsSheet {...props} />
    </SafeAreaInsetsContext.Provider>
  );
  return { props, element };
}

function renderSheet(overrides: Partial<AgentDetailsSheetProps> = {}) {
  const { props, element } = sheet(overrides);
  return { props, ...render(element) };
}

describe("agent details sheet", () => {
  afterEach(cleanup);

  it("is closed until it is asked for, and closes when it is dragged away", () => {
    const { props, rerender } = renderSheet({ visible: false });
    expect(mockSheet.isPresented).toBe(false);

    rerender(sheet({ visible: true, onClose: props.onClose }).element);
    expect(mockSheet.isPresented).toBe(true);
    act(() => mockSheet.onDismiss());

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("starts with the grabber, 10pt from the top, which stays put while the rest scrolls", () => {
    renderSheet();

    const first = screen.getByTestId("agent-details").children[0];
    expect(typeof first === "string" ? first : first.props.testID).toBe("agent-details-grabber");
    expect(flat(screen.getByTestId("agent-details-grabber"))).toMatchObject({ width: 36, height: 5, marginTop: 10 });
    expect(within(screen.getByTestId("agent-details-scroll")).queryByTestId("agent-details-grabber")).toBeNull();
  });

  it("pads the content 20pt at the sides and 10pt past the home indicator, with 18pt between blocks", () => {
    renderSheet();

    const content = flat({ props: { style: screen.getByTestId("agent-details-scroll").props.contentContainerStyle } });
    expect(content).toMatchObject({ paddingHorizontal: 20, paddingBottom: 34 + 10, gap: 18, paddingTop: 18 });
  });

  it("scrolls when it is taller than the space under the chat's top bar", () => {
    renderSheet();

    const { maxHeight } = flat(screen.getByTestId("agent-details-scroll"));
    // The window, less the status bar inset, the 52pt top bar and the grabber above the content.
    expect(maxHeight).toBe(1334 - 62 - 52 - 10 - 5);
  });

  it("heads the sheet with the 48pt mascot, 12pt from the name over the description", () => {
    renderSheet();

    const head = screen.getByTestId("agent-details-head");
    expect(flat(head)).toMatchObject({ flexDirection: "row", alignItems: "center", gap: 12 });
    expect(within(head).UNSAFE_getByType(AgentMascot).props).toMatchObject({
      id: "bot_research1", name: "Account research", category: "sales", size: 48,
    });
    expect(flat(within(head).getByRole("header", { name: "Account research" }))).toMatchObject({
      fontFamily: "Geist_600SemiBold", fontSize: 18, lineHeight: 25, color: "#242323",
    });
    expect(flat(within(head).getByText("Briefs you before every sales call"))).toMatchObject({
      fontFamily: "Geist_400Regular", fontSize: 13, lineHeight: 18, color: "#635F5F",
    });
  });

  it("leaves the description out when the agent has none", () => {
    renderSheet({ agent: { ...agent, description: "" } });

    expect(within(screen.getByTestId("agent-details-head")).getAllByText(/./)).toHaveLength(1);
  });

  it("lists the agent's apps in a filled card under an Apps label", () => {
    renderSheet();

    const apps = screen.getByTestId("agent-details-apps");
    expect(flat(apps)).toMatchObject({
      backgroundColor: "#FAF9F7", borderRadius: 14, paddingTop: 10, paddingHorizontal: 14, paddingBottom: 4,
    });
    expect(flat(within(apps).getByRole("header", { name: "Apps" }))).toMatchObject({
      fontSize: 12, lineHeight: 17, textTransform: "uppercase", color: "#8A8686",
    });
    const rows = within(apps).getAllByTestId(/^agent-app-/);
    expect(rows.map((row) => row.props.testID)).toEqual([
      "agent-app-web_search", "agent-app-google_drive", "agent-app-google_calendar",
    ]);
    expect(flat(rows[0])).toMatchObject({ flexDirection: "row", alignItems: "center", paddingVertical: 10 });
    expect(flat(within(rows[0]).getByText("Web Search"))).toMatchObject({
      fontFamily: "Geist_400Regular", fontSize: 15, lineHeight: 22, color: "#242323",
    });
  });

  it("marks a granted app as Connected with a green dot, and words the other states plainly", () => {
    renderSheet();

    const granted = screen.getByTestId("agent-app-web_search");
    expect(within(granted).UNSAFE_getByType(StatusDot).props.tone).toBe("active");
    expect(flat(within(granted).getByText("Connected"))).toMatchObject({
      fontFamily: "Geist_400Regular", fontSize: 14, lineHeight: 20, color: "#635F5F",
    });

    const pending = screen.getByTestId("agent-app-google_drive");
    expect(within(pending).getByText("Connected, not granted")).toBeTruthy();
    expect(within(pending).UNSAFE_queryByType(StatusDot)).toBeNull();

    const missing = screen.getByTestId("agent-app-google_calendar");
    expect(within(missing).getByText("Not connected")).toBeTruthy();
    expect(within(missing).UNSAFE_queryByType(StatusDot)).toBeNull();
  });

  it.each([
    ["the agent has no connections", { authority: { ...authority, connections: [] } }],
    ["its access could not be read", { authority: null }],
  ])("hides the Apps section when %s", (_case, overrides) => {
    renderSheet(overrides as never);

    expect(screen.queryByTestId("agent-details-apps")).toBeNull();
    expect(screen.queryByRole("header", { name: "Apps" })).toBeNull();
  });

  it("says what the agent runs on in an outlined box with a lock", () => {
    renderSheet();

    const box = screen.getByTestId("agent-details-runs-on");
    expect(flat(box)).toMatchObject({
      flexDirection: "row", alignItems: "center", gap: 10,
      borderWidth: 1, borderColor: "#F3F2F2", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    });
    expect(within(box).UNSAFE_getByType(Icon).props).toMatchObject({ icon: LockIcon, size: 16 });
    expect(flat(within(box).getByText("Runs on Pi · Claude Sonnet 5 via Matrix AI"))).toMatchObject({
      fontFamily: "Geist_500Medium", fontSize: 13, lineHeight: 18, color: "#242323",
    });
    // One line: the model can still be changed below, so nothing says it was set for good.
    expect(within(box).getAllByText(/./)).toHaveLength(1);
    expect(screen.queryByText("Set when the agent was created")).toBeNull();
  });

  it("leaves the box out when nothing is known about what the agent runs on", () => {
    renderSheet({ runsOn: null });

    expect(screen.queryByTestId("agent-details-runs-on")).toBeNull();
  });

  it("ends with an outline Archive agent button the width of the sheet", () => {
    const { props } = renderSheet();

    const archive = screen.getByRole("button", { name: "Archive agent" });
    expect(flat(archive)).toMatchObject({
      height: 44, alignSelf: "stretch", backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E5E5E5",
    });
    fireEvent.press(archive);

    expect(props.onArchive).toHaveBeenCalledTimes(1);
  });

  it("shows the archive request in flight on the button", () => {
    const { props } = renderSheet({ archiving: true });

    const archive = screen.getByRole("button", { name: "Archive agent" });
    expect(archive.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    expect(within(archive).UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
    fireEvent.press(archive);

    expect(props.onArchive).not.toHaveBeenCalled();
  });

  it("offers no Archive agent while the agent itself is not known", () => {
    renderSheet({ onArchive: undefined });

    expect(screen.queryByRole("button", { name: "Archive agent" })).toBeNull();
  });

  it("draws none of the controls the server has nothing behind", () => {
    renderSheet();

    for (const label of ["Edit", "Pause agent", "Always allow"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    expect(screen.queryByRole("header", { name: "Schedule" })).toBeNull();
    for (const text of ["Runs", "Before each meeting", "Runs before each meeting"]) {
      expect(screen.queryByText(text)).toBeNull();
    }
  });

  it("has only the head and Archive agent to show for an agent with nothing else known", () => {
    renderSheet({ authority: null, runsOn: null });

    expect(screen.getAllByRole("header").map((header) => header.props.children)).toEqual(["Account research"]);
    expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual(["Archive agent"]);
  });
});
