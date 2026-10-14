import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { contentShape, shapes } from "@expo/ui/swift-ui/modifiers";

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

  describe("what it lifts", () => {
    function layOutRow(width: number) {
      const row = screen.UNSAFE_getAllByType(View).find((view) => view.props.onLayout)!;
      fireEvent(row, "layout", { nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
      return row;
    }
    const hostedContent = () => screen.getByTestId("context-menu-preview").findByType(View);

    it("gives content that fills its row the row's width, as SwiftUI does not", () => {
      renderMenu({ chatId: "chat_1", messageText: REPLY });

      layOutRow(362);

      expect(StyleSheet.flatten(hostedContent().props.style)).toEqual({ width: 362 });
      expect(hostedContent().findByProps({ testID: "row" })).toBeTruthy();
    });

    it("keeps content at its own size against the row's end, bounded by the row", () => {
      render(
        <ChatContextMenu chatId="chat_1" messageText={REPLY} fit="end">
          <Pressable testID="row"><Text>Row</Text></Pressable>
        </ChatContextMenu>,
      );

      const row = layOutRow(362);

      expect(StyleSheet.flatten(row.props.style)).toMatchObject({ alignSelf: "stretch", alignItems: "flex-end" });
      expect(StyleSheet.flatten(hostedContent().props.style)).toEqual({ maxWidth: 362 });
    });

    it("leaves room inside what it lifts without moving the content", () => {
      render(
        <ChatContextMenu chatId="chat_1" messageText={REPLY} inset={10}>
          <Pressable testID="row"><Text>Row</Text></Pressable>
        </ChatContextMenu>,
      );

      const row = layOutRow(382);

      expect(StyleSheet.flatten(row.props.style)).toMatchObject({ margin: -10 });
      expect(StyleSheet.flatten(hostedContent().props.style)).toEqual({ width: 382, padding: 10 });
    });

    it("fills what it lifts when asked, so the lift's shadow cannot show through the content", () => {
      render(
        <ChatContextMenu chatId="chat_1" messageText={REPLY} backgroundColor="#FFFEFC">
          <Pressable testID="row"><Text>Row</Text></Pressable>
        </ChatContextMenu>,
      );

      const row = layOutRow(362);

      expect(StyleSheet.flatten(hostedContent().props.style)).toEqual({ width: 362, backgroundColor: "#FFFEFC" });
      // The row around it stays clear.
      expect(StyleSheet.flatten(row.props.style).backgroundColor).toBeUndefined();
    });

    it("leaves content without a fill clear", () => {
      renderMenu({ chatId: "chat_1", messageText: REPLY });

      layOutRow(362);

      expect(StyleSheet.flatten(hostedContent().props.style).backgroundColor).toBeUndefined();
    });

    it("lays the content out without the window's safe areas, so a row near an edge is drawn whole", () => {
      renderMenu({ chatId: "chat_1", messageText: REPLY });

      expect(screen.getByTestId("swift-ui-host").props.hostSettings).toEqual({
        matchContents: { vertical: true },
        ignoreSafeArea: "all",
      });
    });

    it("gives the lifted preview the content's corners", () => {
      render(
        <ChatContextMenu chatId="chat_1" messageText={REPLY} cornerRadius={18}>
          <Pressable testID="row"><Text>Row</Text></Pressable>
        </ChatContextMenu>,
      );

      expect(screen.getByTestId("context-menu-preview").props.previewModifiers).toEqual([
        contentShape(shapes.roundedRectangle({ cornerRadius: 18 }), "contextMenuPreview"),
      ]);
    });
  });
});
