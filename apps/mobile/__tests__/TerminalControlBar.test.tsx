// The shared stand-in only draws Ionicons; the keyboard key uses Material glyphs.
jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  const mockReact = require("react");
  const MockGlyph = function MockGlyph(props: { name: string }) {
    return mockReact.createElement(Text, { testID: `icon-${props.name}` }, props.name);
  };
  return { Ionicons: MockGlyph, MaterialCommunityIcons: MockGlyph };
});

import React from "react";
import * as Clipboard from "expo-clipboard";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaInsetsContext, type EdgeInsets } from "react-native-safe-area-context";
import type { ReactTestInstance } from "react-test-renderer";

import { TerminalControlBar } from "../components/TerminalControlBar";
import { sendTerminalClipboardPaste } from "../lib/terminal-controls";

const NO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

function renderBar(
  overrides: Partial<React.ComponentProps<typeof TerminalControlBar>> = {},
  insets: EdgeInsets = NO_INSETS,
) {
  const props: React.ComponentProps<typeof TerminalControlBar> = {
    onSend: jest.fn(),
    onScroll: jest.fn(),
    onScrollToBottom: jest.fn(),
    onShowKeyboard: jest.fn(),
    onDismissKeyboard: jest.fn(),
    keyboardVisible: true,
    expanded: false,
    onExpandedChange: jest.fn(),
    ctrlArmed: false,
    onToggleCtrl: jest.fn(),
    ...overrides,
  };
  const view = render(
    <SafeAreaInsetsContext.Provider value={insets}>
      <TerminalControlBar {...props} />
    </SafeAreaInsetsContext.Provider>,
  );
  return { props, view };
}

describe("TerminalControlBar", () => {
  it("keeps the keys agents need in the row that is always shown", () => {
    const { props } = renderBar();

    for (const label of ["Stop", "esc", "tab", "ctrl", "Arrow up", "Arrow down", "Hide keyboard", "More keys", "Enter"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    // Nothing from the extra pages is drawn while they are folded away.
    expect(screen.queryByLabelText("Arrow left")).toBeNull();

    fireEvent.press(screen.getByLabelText("Arrow up"));
    fireEvent.press(screen.getByLabelText("Arrow down"));
    fireEvent.press(screen.getByLabelText("Stop"));
    fireEvent.press(screen.getByLabelText("esc"));
    expect(props.onSend).toHaveBeenNthCalledWith(1, "\x1b[A");
    expect(props.onSend).toHaveBeenNthCalledWith(2, "\x1b[B");
    expect(props.onSend).toHaveBeenNthCalledWith(3, "\x03");
    expect(props.onSend).toHaveBeenNthCalledWith(4, "\x1b");
  });

  it("offers no zellij mode keys on any page", () => {
    renderBar({ expanded: true });
    const assertNoZellijKeys = () => {
      for (const label of ["^P", "^O", "^T", "^W", "^N", "^S", "^G", "^Q"]) {
        expect(screen.queryByText(label)).toBeNull();
      }
      expect(screen.queryByLabelText(/zellij|lock mode|tab mode|session mode/i)).toBeNull();
    };

    assertNoZellijKeys();
    fireEvent.press(screen.getByLabelText("Next keys page"));
    assertNoZellijKeys();
  });

  it("folds the extra keys away when Enter is pressed", () => {
    const { props } = renderBar({ expanded: true });

    fireEvent.press(screen.getByLabelText("Enter"));

    expect(props.onSend).toHaveBeenCalledWith("\r");
    expect(props.onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("opens the extra keys from More and closes them from the same key", () => {
    const folded = renderBar();
    fireEvent.press(screen.getByLabelText("More keys"));
    expect(folded.props.onExpandedChange).toHaveBeenCalledWith(true);
    folded.view.unmount();

    const open = renderBar({ expanded: true });
    fireEvent.press(screen.getByLabelText("Fewer keys"));
    expect(open.props.onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("splits the extra keys over two pages", () => {
    const { props } = renderBar({ expanded: true });

    for (const label of ["Arrow left", "Arrow right", "Home", "End", "Shift tab", "Paste", "/", "~", "|", "-", "_", "$"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.queryByLabelText("Kill line")).toBeNull();
    fireEvent.press(screen.getByLabelText("Shift tab"));
    fireEvent.press(screen.getByLabelText("Home"));
    fireEvent.press(screen.getByLabelText("|"));
    expect(props.onSend).toHaveBeenNthCalledWith(1, "\x1b[Z");
    expect(props.onSend).toHaveBeenNthCalledWith(2, "\x01");
    expect(props.onSend).toHaveBeenNthCalledWith(3, "|");

    fireEvent.press(screen.getByLabelText("Next keys page"));
    for (const label of ["Kill line", "Search history", "Clear screen", "Page up", "Page down", "Scroll to bottom"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.queryByLabelText("Arrow left")).toBeNull();
    fireEvent.press(screen.getByLabelText("Page up"));
    fireEvent.press(screen.getByLabelText("Scroll to bottom"));
    expect(props.onScroll).toHaveBeenCalledWith(-18);
    expect(props.onScrollToBottom).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByLabelText("Previous keys page"));
    expect(screen.getByLabelText("Arrow left")).toBeTruthy();
  });

  it("fits every row on a 320pt wide screen", () => {
    const narrowest = 320;
    const check = () => {
      const barStyle = StyleSheet.flatten(screen.getByTestId("terminal-control-bar").props.style);
      for (const row of screen.getAllByTestId("terminal-key-row")) {
        const rowStyle = StyleSheet.flatten(row.props.style);
        const keys = row.findAll(
          (node: ReactTestInstance) => node.props.accessibilityRole === "button" && typeof node.type === "string",
        );
        const floors = keys.map((key: ReactTestInstance) => {
          const style = StyleSheet.flatten(key.props.style);
          expect(style.flexShrink).toBe(1);
          return style.minWidth as number;
        });
        const smallest = floors.reduce((sum: number, floor: number) => sum + floor, 0)
          + rowStyle.gap * (keys.length - 1)
          + barStyle.paddingHorizontal * 2;
        expect(keys.length).toBeGreaterThan(0);
        expect(smallest).toBeLessThanOrEqual(narrowest);
      }
    };

    renderBar({ expanded: true });
    check();
    fireEvent.press(screen.getByLabelText("Next keys page"));
    check();
  });

  it("keeps the key rows above the home indicator while the keyboard is down", () => {
    const insets = { ...NO_INSETS, bottom: 34 };
    const hidden = renderBar({ keyboardVisible: false }, insets);
    const hiddenStyle = StyleSheet.flatten(screen.getByTestId("terminal-control-bar").props.style);
    expect(hiddenStyle.paddingBottom).toBe(34);
    hidden.view.unmount();

    // With the keyboard up the rows sit on the keyboard, which already covers that edge.
    renderBar({ keyboardVisible: true }, insets);
    const shownStyle = StyleSheet.flatten(screen.getByTestId("terminal-control-bar").props.style);
    expect(shownStyle.paddingBottom).toBe(6);
  });

  it("toggles sticky ctrl and shows when it is armed", () => {
    const off = renderBar();
    expect(screen.getByLabelText("ctrl").props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
    fireEvent.press(screen.getByLabelText("ctrl"));
    expect(off.props.onToggleCtrl).toHaveBeenCalledTimes(1);
    off.view.unmount();

    renderBar({ ctrlArmed: true });
    expect(screen.getByLabelText("ctrl").props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
  });

  it("hides the keyboard while it is up and brings it back when it is down", () => {
    const shown = renderBar({ keyboardVisible: true });
    fireEvent.press(screen.getByLabelText("Hide keyboard"));
    expect(shown.props.onDismissKeyboard).toHaveBeenCalledTimes(1);
    shown.view.unmount();

    const hidden = renderBar({ keyboardVisible: false });
    fireEvent.press(screen.getByLabelText("Show keyboard"));
    expect(hidden.props.onShowKeyboard).toHaveBeenCalledTimes(1);
  });

  it("moves the cursor with a sideways swipe across the keys", () => {
    const { props } = renderBar();
    const bar = screen.getByTestId("terminal-control-bar");
    const at = (pageX: number, pageY: number) => ({ nativeEvent: { pageX, pageY, touches: [{ pageX, pageY }] } });

    fireEvent(bar, "touchStart", at(100, 10));
    // A short wobble stays a tap on whichever key is under the finger.
    expect(bar.props.onMoveShouldSetResponderCapture(at(104, 11))).toBe(false);
    // A real drag takes the touch away from the key.
    expect(bar.props.onMoveShouldSetResponderCapture(at(115, 11))).toBe(true);
    act(() => {
      bar.props.onResponderGrant(at(115, 11));
      bar.props.onResponderMove(at(131, 12));
    });
    expect(jest.mocked(props.onSend).mock.calls).toEqual([["\x1b[C"], ["\x1b[C"]]);

    // Dragging back past the start takes the steps back, then keeps going left.
    act(() => bar.props.onResponderMove(at(72, 12)));
    expect(jest.mocked(props.onSend).mock.calls.slice(2)).toEqual([["\x1b[D"], ["\x1b[D"], ["\x1b[D"], ["\x1b[D"]]);
    act(() => bar.props.onResponderRelease(at(72, 12)));
    expect(bar.props.onResponderTerminationRequest()).toBe(false);
  });

  it("sends clipboard text through the terminal paste action", async () => {
    const onSend = jest.fn();
    jest.spyOn(Clipboard, "getStringAsync").mockResolvedValueOnce("copied text");

    await sendTerminalClipboardPaste(onSend);

    expect(onSend).toHaveBeenCalledWith("copied text");
  });

  it("logs a clipboard that cannot be read and sends nothing", async () => {
    const onSend = jest.fn();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(Clipboard, "getStringAsync").mockRejectedValueOnce(new TypeError("denied"));

    await expect(sendTerminalClipboardPaste(onSend)).resolves.toBeUndefined();

    expect(onSend).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[mobile] terminal paste unavailable", "TypeError");
    warn.mockRestore();
  });
});
