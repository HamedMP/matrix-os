import type { ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react-native";
import { FlatList } from "react-native";

import { AgentApprovalFrame, AgentChatFrame, AgentDetailsFrame } from "../dev/design-preview/agents";
import { AgentMascot } from "../components/ui/AgentMascot";
import { StatusDot } from "../components/ui/StatusDot";
import { deriveAgentMascot } from "../lib/agent-mascot";
import type { TranscriptMessage } from "../lib/canonical-chat-transcript";

import { drawnTestIds } from "./chat-test-utils";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => false }));

let mockSheet: { isPresented: boolean } = { isPresented: false };

jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean }) => {
      mockSheet = props;
      return props.isPresented ? <View testID="expo-bottom-sheet">{props.children}</View> : null;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});

/** The messages the list holds, oldest first, as they read down the screen. */
function messagesTopToBottom(): TranscriptMessage[] {
  return [...(screen.UNSAFE_getByType(FlatList).props.data as TranscriptMessage[])].reverse();
}

describe("agent chat design frames", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSheet = { isPresented: false };
  });

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    cleanup();
    jest.useRealTimers();
  });

  it("A2 heads the chat with Account research and its coral mascot, with no schedule line", () => {
    render(<AgentChatFrame />);

    const bar = screen.getByTestId("agent-chat-top-bar");
    expect(within(bar).getByRole("header", { name: "Account research" })).toBeTruthy();
    const mascot = within(bar).UNSAFE_getByType(AgentMascot).props;
    expect(mascot.size).toBe(32);
    expect(deriveAgentMascot(mascot.id, mascot.category).color).toBe("coral");
    expect(screen.queryByText(/Runs before each meeting/)).toBeNull();
    expect(screen.queryByText(/Agent created/)).toBeNull();
    expect(screen.getByRole("button", { name: "Agent details" })).toBeTruthy();
  });

  it("A2 shows the frame's conversation: the reply with its three steps, then the brief with its card", () => {
    render(<AgentChatFrame />);

    expect(messagesTopToBottom().map((message) => message.text)).toEqual([
      "Your next meeting is with Northwind at 14:00, so I started there.",
      "Brief ready for your call.",
    ]);
    for (const step of ["Read northwind.com", "Checked 6 recent news items", "Wrote the brief"]) {
      expect(screen.getByText(step)).toBeTruthy();
    }
    const card = screen.getByTestId("result-card");
    expect(within(card).getByText("Northwind · account brief")).toBeTruthy();
    expect(within(card).getByText("6 sources")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Open Northwind · account brief" })).toBeTruthy();
    expect(drawnTestIds(screen.root).filter((id) => id === "assistant-message")).toHaveLength(2);
  });

  it("A2 asks for a message by the agent's name, with no model control, no tabs and nothing pending", () => {
    render(<AgentChatFrame />);

    expect(screen.getByPlaceholderText("Ask Account research…").props.value).toBe("");
    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("Needs your approval")).toBeNull();
    expect(mockSheet.isPresented).toBe(false);
  });

  it("A3 ends the chat with the approval card, after the agent's question", () => {
    render(<AgentApprovalFrame />);

    expect(messagesTopToBottom().map((message) => message.text)).toEqual([
      "Brief ready for your call.",
      "Want me to share the brief with the deal team?",
    ]);
    expect(screen.getByTestId("result-card")).toBeTruthy();
    // After the newest message: the header of a list drawn from the bottom up.
    expect(screen.UNSAFE_getByType(FlatList).props.ListHeaderComponent).toBeTruthy();
    const card = screen.getByTestId("agent-approval-sample");
    expect(within(card).UNSAFE_getByType(StatusDot).props.tone).toBe("waiting");
    expect(within(card).getByText("Needs your approval")).toBeTruthy();
    expect(within(card).getByRole("header", { name: "Post in Slack · #northwind-deal" })).toBeTruthy();
    expect(within(card).getByText(
      "Brief for today's Northwind call: new VP of Ops, expanding to Germany, three open questions on pricing.",
    )).toBeTruthy();
  });

  it("A3 offers Allow once and Deny, and not Always allow", () => {
    render(<AgentApprovalFrame />);

    const card = screen.getByTestId("agent-approval-sample");
    expect(within(card).getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
      "Allow once", "Deny",
    ]);
    expect(screen.queryByText("Always allow")).toBeNull();
  });

  it("A4 opens the details sheet over the agent's chat", () => {
    render(<AgentDetailsFrame />);

    expect(mockSheet.isPresented).toBe(true);
    expect(screen.getByTestId("agent-chat-top-bar")).toBeTruthy();
    const sheet = screen.getByTestId("expo-bottom-sheet");
    expect(within(sheet).getByRole("header", { name: "Account research" })).toBeTruthy();
    expect(within(sheet).getByText("Briefs you before every sales call")).toBeTruthy();
    const mascot = within(sheet).UNSAFE_getByType(AgentMascot).props;
    expect(mascot.size).toBe(48);
    expect(deriveAgentMascot(mascot.id, mascot.category).color).toBe("coral");
  });

  it("A4 lists the frame's three apps as connected, and what the agent runs on", () => {
    render(<AgentDetailsFrame />);

    const apps = within(screen.getByTestId("agent-details-apps")).getAllByTestId(/^agent-app-/);
    expect(apps.map((row) => within(row).getAllByText(/./).map((text) => text.props.children))).toEqual([
      ["Web Search", "Connected"],
      ["Google Drive", "Connected"],
      ["Google Calendar", "Connected"],
    ]);
    for (const row of apps) expect(within(row).UNSAFE_getByType(StatusDot).props.tone).toBe("active");
    expect(screen.getByText("Runs on Pi · Claude Sonnet 5 via Matrix AI")).toBeTruthy();
    expect(screen.queryByText("Set when the agent was created")).toBeNull();
  });

  it("A4 offers Archive agent alone: no Edit, no Schedule, no Pause", () => {
    render(<AgentDetailsFrame />);

    const sheet = screen.getByTestId("expo-bottom-sheet");
    expect(within(sheet).getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
      "Archive agent",
    ]);
    expect(within(sheet).getAllByRole("header").map((header) => header.props.children)).toEqual([
      "Account research", "Apps",
    ]);
    for (const text of ["Edit", "Schedule", "Runs", "Before each meeting", "Pause agent"]) {
      expect(screen.queryByText(text)).toBeNull();
    }
  });
});
