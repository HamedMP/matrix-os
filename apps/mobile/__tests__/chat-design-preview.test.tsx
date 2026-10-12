import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { FlatList, KeyboardAvoidingView, Platform } from "react-native";

import { CHAT_SUGGESTIONS } from "../components/chat/chat-suggestions";
import { DesignPreview } from "../dev/design-preview/DesignPreview";
import type { TranscriptMessage } from "../lib/canonical-chat-transcript";

import { drawnTestIds } from "./chat-test-utils";
import { flat } from "./ui-test-utils";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const mockSetParams = jest.fn();
let mockKeyboardVisible = false;

jest.mock("expo-router", () => ({ useRouter: () => ({ setParams: mockSetParams }) }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => mockKeyboardVisible }));

describe("chat frames in the design preview", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    cleanup();
    jest.useRealTimers();
    jest.clearAllMocks();
    mockKeyboardVisible = false;
  });

  it("lists C1, C1b and C1c beside the components gallery", () => {
    render(<DesignPreview frame={undefined} />);

    for (const name of ["components", "C1", "C1b", "C1c"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.press(screen.getByRole("button", { name: "C1b" }));
    expect(mockSetParams).toHaveBeenCalledWith({ frame: "C1b" });
  });

  it("draws C1: a new chat with the greeting, the three suggestions and an empty composer", () => {
    render(<DesignPreview frame="C1" />);

    expect(screen.getByRole("header", { name: "New chat" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "What should we work on?" })).toBeTruthy();
    for (const suggestion of CHAT_SUGGESTIONS) {
      expect(screen.getByRole("button", { name: suggestion })).toBeTruthy();
    }
    expect(screen.getByPlaceholderText("Ask anything").props.value).toBe("");
    expect(screen.getByText("Matrix AI · Sonnet 5")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
  });

  it("draws C1b: the chat in progress, top to bottom as in the frame, with a turn running", () => {
    render(<DesignPreview frame="C1b" />);

    expect(screen.getByRole("header", { name: "Habit tracker app" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    // The list is drawn from the bottom up, so it holds its newest message first.
    const messages = screen.UNSAFE_getByType(FlatList).props.data as TranscriptMessage[];
    expect([...messages].reverse().map((message) => message.text)).toEqual([
      "Build an app that tracks my habits",
      "Done. It has a daily checklist and shows your streak for each habit.",
      "Add a weekly view too",
      "",
    ]);
    // Within a reply the order is the frame's: text, steps, result card.
    const [working, answer] = screen.getAllByTestId("assistant-message");
    expect(drawnTestIds(answer!)).toEqual(["assistant-text", "steps-block", "result-card"]);
    expect(drawnTestIds(working!)).toEqual(["steps-block"]);
    for (const text of [
      "Read the current app",
      "Adding the weekly view…",
      "Created the app",
      "Added a daily checklist",
      "Saved to My apps",
      "Habit tracker",
      "App · My apps",
    ]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getAllByText("Done. It has a daily checklist and shows your streak for each habit.").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Open Habit tracker" })).toBeTruthy();
    expect(screen.getAllByTestId("steps-block")).toHaveLength(2);
    expect(screen.getAllByTestId("result-card")).toHaveLength(1);
    expect(screen.getByPlaceholderText("Reply…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("draws C1c: the first turn with the follow-up typed and the composer focused", () => {
    render(<DesignPreview frame="C1c" />);

    const input = screen.getByLabelText("Message Matrix");
    expect(input.props.value).toBe("Add a weekly view too");
    expect(input.props.autoFocus).toBe(true);
    expect(screen.getByRole("header", { name: "Habit tracker app" })).toBeTruthy();
    expect(screen.getByText("Saved to My apps")).toBeTruthy();
    expect(screen.getByText("Habit tracker")).toBeTruthy();
    // The follow-up has not been sent yet, so there is no second turn.
    expect(screen.queryByText("Adding the weekly view…")).toBeNull();
    expect(screen.getAllByTestId("user-message")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send message" }).props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("lets the typed follow-up be edited in the preview", () => {
    render(<DesignPreview frame="C1c" />);

    fireEvent.changeText(screen.getByLabelText("Message Matrix"), "");

    expect(screen.getByLabelText("Message Matrix").props.value).toBe("");
    expect(screen.getByRole("button", { name: "Send message" }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it.each(["C1", "C1b", "C1c"])("puts %s inside the real insets with the tab bar beneath it, Chats active and two agents waiting", (frame) => {
    render(<DesignPreview frame={frame} />);

    expect(flat(screen.UNSAFE_getByType(KeyboardAvoidingView)).paddingTop).toBe(62);
    expect(flat(screen.getByTestId("chat-frame-tabs")).paddingBottom).toBe(34);
    expect(screen.getByRole("tab", { name: "Chats" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole("tab", { name: "Agents, 2 waiting" })).toBeTruthy();
    expect(flat(screen.getByTestId("chat-frame"))).toMatchObject({ flex: 1, backgroundColor: "#FFFEFC" });
  });

  it("hides the tab bar under an open keyboard on Android, as the app does", () => {
    const os = Platform.OS;
    Platform.OS = "android";
    mockKeyboardVisible = true;
    try {
      render(<DesignPreview frame="C1c" />);
      expect(screen.queryByTestId("chat-frame-tabs")).toBeNull();
      expect(screen.queryByRole("tab", { name: "Chats" })).toBeNull();
    } finally {
      Platform.OS = os;
    }
  });
});
