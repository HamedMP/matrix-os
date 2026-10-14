import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

import * as mockContextMenu from "./context-menu-test-utils";
import { ChatContextMenu } from "../components/ChatContextMenu";
import { ToastHost } from "../components/ui/Toast";

import { menuAround, menuItem, menuItemLabels } from "./context-menu-test-utils";

// Jest resolves the iOS files, so this is the native context menu.
jest.mock("@expo/ui/swift-ui", () => mockContextMenu.swiftUiContextMenuModule());

const REPLY = "Done. It has a daily checklist.";

function renderMenu(props: { chatId?: string | null; messageText?: string | null }, onPress = jest.fn()) {
  const view = render(
    <>
      <ChatContextMenu {...props}>
        <Pressable testID="row" onPress={onPress}><Text>Row</Text></Pressable>
      </ChatContextMenu>
      <ToastHost />
    </>,
  );
  return { ...view, onPress };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  // Ends the toast on screen, so the next test starts without one.
  act(() => jest.runOnlyPendingTimers());
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("ChatContextMenu on iOS", () => {
  it("offers Copy text, Share and Copy chat ID for a message, in that order", () => {
    renderMenu({ chatId: "chat_1", messageText: REPLY });

    const menu = menuAround(screen.getByTestId("row"));
    expect(menuItemLabels(menu)).toEqual(["Copy text", "Share", "Copy chat ID"]);
    expect(menuItem(screen.getByTestId("row"), "Copy text").props.accessibilityHint).toBe("doc.on.doc");
    expect(menuItem(screen.getByTestId("row"), "Copy chat ID").props.accessibilityHint).toBe("number");
    // The system's own share row, handed the message's text.
    expect(screen.getByTestId("context-menu-share").props.accessibilityValue).toEqual({ text: REPLY });
  });

  it("offers only Copy chat ID for a chat as a whole", () => {
    renderMenu({ chatId: "chat_1" });

    expect(menuItemLabels(menuAround(screen.getByTestId("row")))).toEqual(["Copy chat ID"]);
  });

  it("offers the text of a message in a chat that does not exist yet, but no chat ID", () => {
    renderMenu({ chatId: null, messageText: REPLY });

    expect(menuItemLabels(menuAround(screen.getByTestId("row")))).toEqual(["Copy text", "Share"]);
  });

  it("draws no menu when there is nothing to offer", () => {
    const view = renderMenu({ chatId: null, messageText: "   " });
    expect(screen.queryByTestId("context-menu")).toBeNull();

    view.rerender(
      <ChatContextMenu>
        <Pressable testID="row"><Text>Row</Text></Pressable>
      </ChatContextMenu>,
    );
    expect(screen.queryByTestId("context-menu")).toBeNull();
    expect(screen.getByTestId("row")).toBeTruthy();
  });

  it("gives a medium haptic as the menu opens, without pressing what it opens on", () => {
    const { onPress } = renderMenu({ chatId: "chat_1", messageText: REPLY });

    fireEvent(screen.getByTestId("row"), "longPress");

    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("copies the message's text and says so in a toast rather than an alert", async () => {
    const alert = jest.spyOn(Alert, "alert");
    renderMenu({ chatId: "chat_1", messageText: REPLY });

    fireEvent.press(menuItem(screen.getByTestId("row"), "Copy text"));

    await waitFor(() => expect(screen.getByText("Text copied")).toBeTruthy());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(REPLY);
    expect(alert).not.toHaveBeenCalled();
  });

  it("copies the full chat ID without opening the chat", async () => {
    const { onPress } = renderMenu({ chatId: "chat_native_full_id" });

    fireEvent.press(menuItem(screen.getByTestId("row"), "Copy chat ID"));

    await waitFor(() => expect(screen.getByText("Chat ID copied")).toBeTruthy());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("chat_native_full_id");
    expect(onPress).not.toHaveBeenCalled();
  });

  it("says in its own words when the clipboard fails, never the platform's", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(Clipboard, "setStringAsync").mockRejectedValueOnce(new Error("secret native failure"));
    renderMenu({ chatId: "chat_1", messageText: REPLY });

    fireEvent.press(menuItem(screen.getByTestId("row"), "Copy text"));

    await waitFor(() => expect(screen.getByText("Could not copy text. Try again.")).toBeTruthy());
    expect(screen.getByTestId("toast").props.accessibilityRole).toBe("alert");
    expect(JSON.stringify(screen.toJSON())).not.toContain("secret native failure");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret native failure");
  });

  it("treats a clipboard that refuses the text as a failure", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(Clipboard, "setStringAsync").mockResolvedValueOnce(false);
    renderMenu({ chatId: "chat_1" });

    fireEvent.press(menuItem(screen.getByTestId("row"), "Copy chat ID"));

    await waitFor(() => expect(screen.getByText("Could not copy chat ID. Try again.")).toBeTruthy());
  });

  it("says nothing about a copy that ends after its message has gone", async () => {
    let finish!: (copied: boolean) => void;
    jest.spyOn(Clipboard, "setStringAsync").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderMenu({ chatId: "chat_1", messageText: REPLY });

    fireEvent.press(menuItem(screen.getByTestId("row"), "Copy text"));
    view.rerender(<ToastHost />);
    await act(async () => finish(true));

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(REPLY);
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("gives what it opens on the width of its row, as SwiftUI does not", () => {
    renderMenu({ chatId: "chat_1", messageText: REPLY });

    const views = () => screen.UNSAFE_getAllByType(View);
    const row = views().find((view) => view.props.onLayout)!;
    fireEvent(row, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 362, height: 40 } } });

    const sized = views().filter((view) => StyleSheet.flatten(view.props.style)?.width === 362);
    expect(sized).toHaveLength(1);
    expect(sized[0]!.findByProps({ testID: "row" })).toBeTruthy();
  });
});
