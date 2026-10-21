const mockConnect = jest.fn();
const mockDetach = jest.fn();
const mockSendInput = jest.fn(() => true);
const mockSendBinary = jest.fn(() => true);
const mockResize = jest.fn(() => true);
const mockGatewayClient = {};
const mockSurfaceWrite = jest.fn();
const mockSurfaceClear = jest.fn();
const mockSurfaceReset = jest.fn();
const mockSurfaceResize = jest.fn();
const mockSurfaceFocus = jest.fn();
const mockSurfaceBlur = jest.fn();
const mockSurfaceScrollLines = jest.fn();
const mockSurfaceScrollToBottom = jest.fn();
const mockScreenOptions = jest.fn();
const mockUseComputerTerminals = jest.fn();
const SESSION_ID = "tws_00000000000000000000000000000001:tt_00000000000000000000000000000001";
let mockSessionParam: string | undefined;
let mockHeaderHeight = 0;

jest.mock("expo-router", () => ({
  Stack: {
    Screen: ({ options }: { options?: unknown }) => {
      mockScreenOptions(options);
      return null;
    },
  },
  useLocalSearchParams: () => ({ session: mockSessionParam }),
}));

jest.mock("expo-router/react-navigation", () => ({
  useHeaderHeight: () => mockHeaderHeight,
}));

jest.mock("@/lib/queries/use-computer-terminals", () => ({
  useComputerTerminals: () => mockUseComputerTerminals(),
}));

jest.mock("@/app/_layout", () => ({
  useGateway: () => ({ client: mockGatewayClient }),
}));

jest.mock("@/lib/terminal-client", () => ({
  MobileTerminalClient: jest.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

jest.mock("@/components/TerminalSurface", () => {
  const React = require("react");
  const { Pressable, Text, View } = require("react-native");
  return {
    TerminalSurface: React.forwardRef((props: {
      onInput: (data: string) => void;
      onBinary: (data: string) => void;
      onKeys?: (data: string) => void;
      onResize: (cols: number, rows: number) => void;
    }, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({
        write: mockSurfaceWrite,
        clear: mockSurfaceClear,
        reset: mockSurfaceReset,
        resize: mockSurfaceResize,
        focus: mockSurfaceFocus,
        blur: mockSurfaceBlur,
        scrollLines: mockSurfaceScrollLines,
        scrollToBottom: mockSurfaceScrollToBottom,
        reportCursor: jest.fn(),
      }));
      return React.createElement(View, { testID: "terminal-surface" },
        React.createElement(Pressable, {
          accessibilityLabel: "Type terminal input",
          onPress: () => props.onInput("a"),
        }, React.createElement(Text, null, "terminal")),
        React.createElement(Pressable, {
          accessibilityLabel: "Type return",
          onPress: () => props.onInput("\r"),
        }, React.createElement(Text, null, "return")),
        React.createElement(Pressable, {
          accessibilityLabel: "Tap to move the cursor",
          onPress: () => props.onKeys?.("\x1b[C\x1b[C"),
        }, React.createElement(Text, null, "tap")),
        React.createElement(Pressable, {
          accessibilityLabel: "Reply with cursor position",
          onPress: () => props.onInput("\x1b[12;5R"),
        }, React.createElement(Text, null, "cursor report")),
        React.createElement(Pressable, {
          accessibilityLabel: "Send terminal protocol reply",
          onPress: () => props.onBinary("\x1b]10;?\x07"),
        }, React.createElement(Text, null, "protocol")),
        React.createElement(Pressable, {
          accessibilityLabel: "Report terminal viewport",
          onPress: () => props.onResize(49, 18),
        }, React.createElement(Text, null, "viewport")),
      );
    }),
  };
});

interface MockBarProps {
  onSend: (data: string) => void;
  onShowKeyboard: () => void;
  onDismissKeyboard: () => void;
  keyboardVisible: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
}
let mockBarProps: MockBarProps | undefined;

jest.mock("@/components/TerminalControlBar", () => ({
  TerminalControlBar: (props: MockBarProps) => {
    mockBarProps = props;
    return null;
  },
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Keyboard, KeyboardAvoidingView } from "react-native";

import TerminalSessionScreen from "../app/terminal-session/[session]";

describe("live terminal session modal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSessionParam = SESSION_ID;
    mockHeaderHeight = 0;
    mockUseComputerTerminals.mockReturnValue({ sessions: [{ id: SESSION_ID, name: "swift-falcon" }] });
    mockConnect.mockResolvedValue({
      detach: mockDetach,
      sendInput: mockSendInput,
      sendBinary: mockSendBinary,
      resize: mockResize,
      close: jest.fn(),
    });
  });

  it("attaches the terminal surface to the selected VPS session", async () => {
    const rendered = render(<TerminalSessionScreen />);

    await waitFor(() => expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "tws_00000000000000000000000000000001:tt_00000000000000000000000000000001",
      onMessage: expect.any(Function),
      onStatus: expect.any(Function),
    })));

    const options = mockConnect.mock.calls[0]?.[0] as {
      onMessage: (frame: { type: string; data?: string; ansi?: string; canonicalSize?: { cols: number; rows: number } }) => void;
    };
    act(() => {
      options.onMessage({ type: "attached", canonicalSize: { cols: 100, rows: 30 } });
      options.onMessage({ type: "snapshot", ansi: "ready" });
      options.onMessage({ type: "output", data: "\nhello" });
    });
    expect(mockSurfaceClear).toHaveBeenCalled();
    expect(mockSurfaceResize).toHaveBeenCalledWith(100, 30);
    expect(mockSurfaceWrite).toHaveBeenCalledWith("ready");
    expect(mockSurfaceWrite).toHaveBeenCalledWith("\nhello");
    // The snapshot replaces whatever the emulator held before it is written.
    expect(mockSurfaceReset.mock.invocationCallOrder[0])
      .toBeLessThan(mockSurfaceWrite.mock.invocationCallOrder[0]!);

    fireEvent.press(screen.getByLabelText("Type terminal input"));
    expect(mockSendInput).toHaveBeenCalledWith("a");
    fireEvent.press(screen.getByLabelText("Send terminal protocol reply"));
    expect(mockSendBinary).toHaveBeenCalledWith("\x1b]10;?\x07");

    rendered.unmount();
    expect(mockDetach).toHaveBeenCalled();
  });

  it("lays the emulator out on the grid the computer reports", async () => {
    const rendered = render(<TerminalSessionScreen />);
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    const options = mockConnect.mock.calls[0]?.[0] as {
      onMessage: (frame: { type: string; ansi?: string; canonicalSize?: { cols: number; rows: number } }) => void;
    };

    act(() => {
      options.onMessage({ type: "attached", canonicalSize: { cols: 120, rows: 36 } });
      options.onMessage({ type: "canonical-size", canonicalSize: { cols: 49, rows: 36 } });
      options.onMessage({ type: "snapshot", ansi: "ready", canonicalSize: { cols: 49, rows: 18 } });
    });

    expect(mockSurfaceResize.mock.calls).toEqual([[120, 36], [49, 36], [49, 18]]);
    // The grid is in place before the screen laid out for it is written.
    expect(mockSurfaceResize.mock.invocationCallOrder[2])
      .toBeLessThan(mockSurfaceWrite.mock.invocationCallOrder[0]!);
    rendered.unmount();
  });

  it("declares the size that fits the screen to the live connection", async () => {
    const rendered = render(<TerminalSessionScreen />);
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    fireEvent.press(screen.getByLabelText("Report terminal viewport"));

    expect(mockResize).toHaveBeenCalledWith(49, 18);
    rendered.unmount();
  });

  it("lifts the key rows clear of the keyboard by counting the header above the screen", async () => {
    mockHeaderHeight = 116;
    const rendered = render(<TerminalSessionScreen />);
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());

    // The avoiding view starts below the modal's header, so without the
    // header's height its lift falls short by exactly that much.
    expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(116);
    rendered.unmount();
  });

  it("titles the modal with the terminal's name instead of its reference", async () => {
    const rendered = render(<TerminalSessionScreen />);
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());

    expect(mockScreenOptions).toHaveBeenLastCalledWith({ title: "swift-falcon" });
    rendered.unmount();
  });

  it("falls back to a generic title for a terminal the list does not know", async () => {
    mockUseComputerTerminals.mockReturnValue({ sessions: [] });
    const rendered = render(<TerminalSessionScreen />);
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());

    expect(mockScreenOptions).toHaveBeenLastCalledWith({ title: "Terminal" });
    rendered.unmount();
  });

  it("refuses a legacy session name without opening a socket", () => {
    mockSessionParam = "swift-falcon";
    render(<TerminalSessionScreen />);

    expect(screen.getByText("Terminal unavailable. Try again.")).toBeTruthy();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockScreenOptions).toHaveBeenLastCalledWith({ title: "Terminal" });
  });

  it("stops showing an indefinite loader when the socket handshake never opens", async () => {
    jest.useFakeTimers();
    mockConnect.mockImplementationOnce(async (options: { onStatus: (status: "open") => void }) => {
      options.onStatus("open");
      return {
        detach: mockDetach,
        sendInput: mockSendInput,
        sendBinary: mockSendBinary,
        resize: mockResize,
        close: jest.fn(),
      };
    });
    render(<TerminalSessionScreen />);

    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    act(() => jest.advanceTimersByTime(15_000));

    expect(screen.getByText("Terminal unavailable. Try again.")).toBeTruthy();
    jest.useRealTimers();
  });

  it("shows a terminal the computer lists as exited as ended, without attaching to it", async () => {
    mockUseComputerTerminals.mockReturnValue({
      sessions: [{ id: SESSION_ID, name: "swift-falcon", status: "exited" }],
    });
    render(<TerminalSessionScreen />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("This terminal session has ended.")).toBeTruthy();
    expect(mockConnect).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText("Type terminal input"));
    expect(mockSendInput).not.toHaveBeenCalled();
    expect(screen.queryByText("Terminal unavailable. Try again.")).toBeNull();
  });

  it("ends the live view once the computer lists the terminal as exited", async () => {
    const rendered = render(<TerminalSessionScreen />);
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    const options = mockConnect.mock.calls[0]?.[0] as {
      onMessage: (frame: { type: string; canonicalSize?: { cols: number; rows: number } }) => void;
    };
    act(() => options.onMessage({ type: "attached", canonicalSize: { cols: 49, rows: 36 } }));

    mockUseComputerTerminals.mockReturnValue({
      sessions: [{ id: SESSION_ID, name: "swift-falcon", status: "exited" }],
    });
    rendered.rerender(<TerminalSessionScreen />);

    expect(screen.getByText("This terminal session has ended.")).toBeTruthy();
    expect(mockDetach).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    mockSendInput.mockClear();
    fireEvent.press(screen.getByLabelText("Type terminal input"));
    expect(mockSendInput).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("stays on the ended state when the emulator sends more input after the session exits", async () => {
    const rendered = render(<TerminalSessionScreen />);
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    const options = mockConnect.mock.calls[0]?.[0] as {
      onMessage: (frame: { type: string; canonicalSize?: { cols: number; rows: number } }) => void;
    };

    act(() => {
      options.onMessage({ type: "attached", canonicalSize: { cols: 49, rows: 36 } });
      options.onMessage({ type: "exit" });
    });
    mockSendInput.mockClear();
    mockSendBinary.mockClear();
    fireEvent.press(screen.getByLabelText("Type terminal input"));
    fireEvent.press(screen.getByLabelText("Send terminal protocol reply"));

    expect(screen.getByText("This terminal session has ended.")).toBeTruthy();
    expect(screen.queryByText("Terminal unavailable. Try again.")).toBeNull();
    expect(mockSendInput).not.toHaveBeenCalled();
    expect(mockSendBinary).not.toHaveBeenCalled();
    expect(mockSurfaceBlur).toHaveBeenCalled();
    rendered.unmount();
  });

  async function openAttached() {
    const rendered = render(<TerminalSessionScreen />);
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    const options = mockConnect.mock.calls[0]?.[0] as {
      onMessage: (frame: { type: string; canonicalSize?: { cols: number; rows: number } }) => void;
    };
    act(() => options.onMessage({ type: "attached", canonicalSize: { cols: 49, rows: 36 } }));
    return rendered;
  }

  it("turns the next letter typed into a control key while ctrl is armed", async () => {
    const rendered = await openAttached();
    mockSurfaceFocus.mockClear();

    act(() => mockBarProps!.onToggleCtrl());
    expect(mockBarProps!.ctrlArmed).toBe(true);
    // The letter comes from the keyboard, so arming ctrl brings it up.
    expect(mockSurfaceFocus).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByLabelText("Type terminal input"));
    expect(mockSendInput).toHaveBeenLastCalledWith("\x01");
    expect(mockBarProps!.ctrlArmed).toBe(false);

    fireEvent.press(screen.getByLabelText("Type terminal input"));
    expect(mockSendInput).toHaveBeenLastCalledWith("a");

    act(() => mockBarProps!.onToggleCtrl());
    act(() => mockBarProps!.onToggleCtrl());
    expect(mockBarProps!.ctrlArmed).toBe(false);
    rendered.unmount();
  });

  it("keeps ctrl armed and the keys open across a reply the emulator sends to the program", async () => {
    const rendered = await openAttached();

    act(() => mockBarProps!.onExpandedChange(true));
    act(() => mockBarProps!.onToggleCtrl());
    fireEvent.press(screen.getByLabelText("Reply with cursor position"));

    expect(mockSendInput).toHaveBeenLastCalledWith("\x1b[12;5R");
    expect(mockBarProps!.ctrlArmed).toBe(true);
    expect(mockBarProps!.expanded).toBe(true);

    fireEvent.press(screen.getByLabelText("Type terminal input"));
    expect(mockSendInput).toHaveBeenLastCalledWith("\x01");
    rendered.unmount();
  });

  it("uses up an armed ctrl when a tap moves the cursor", async () => {
    const rendered = await openAttached();

    act(() => mockBarProps!.onToggleCtrl());
    fireEvent.press(screen.getByLabelText("Tap to move the cursor"));
    expect(mockSendInput).toHaveBeenLastCalledWith("\x1b[C\x1b[C");
    expect(mockBarProps!.ctrlArmed).toBe(false);

    fireEvent.press(screen.getByLabelText("Type terminal input"));
    expect(mockSendInput).toHaveBeenLastCalledWith("a");
    rendered.unmount();
  });

  it("sends a key from the bar as it is and drops an armed ctrl", async () => {
    const rendered = await openAttached();

    act(() => mockBarProps!.onToggleCtrl());
    act(() => mockBarProps!.onSend("\x1b[A"));

    expect(mockSendInput).toHaveBeenLastCalledWith("\x1b[A");
    expect(mockBarProps!.ctrlArmed).toBe(false);
    rendered.unmount();
  });

  it("folds the extra keys away when Return is typed on the keyboard", async () => {
    const rendered = await openAttached();

    act(() => mockBarProps!.onExpandedChange(true));
    expect(mockBarProps!.expanded).toBe(true);

    fireEvent.press(screen.getByLabelText("Type return"));
    expect(mockSendInput).toHaveBeenLastCalledWith("\r");
    expect(mockBarProps!.expanded).toBe(false);
    rendered.unmount();
  });

  it("folds the extra keys away when the keyboard goes down and tells the rows where it is", async () => {
    let listeners: Record<string, (() => void)[]> = {};
    jest.spyOn(Keyboard, "isVisible").mockReturnValue(true);
    jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, listener: () => void) => {
      (listeners[event] ??= []).push(listener);
      return { remove: () => { listeners[event] = (listeners[event] ?? []).filter((item) => item !== listener); } };
    }) as never);
    const emit = (event: string) => act(() => { for (const listener of listeners[event] ?? []) listener(); });

    try {
      const rendered = await openAttached();
      expect(mockBarProps!.keyboardVisible).toBe(true);
      act(() => mockBarProps!.onExpandedChange(true));

      emit("keyboardWillHide");
      expect(mockBarProps!.keyboardVisible).toBe(false);
      expect(mockBarProps!.expanded).toBe(false);

      // Opening the extra keys again with the keyboard down keeps them open.
      act(() => mockBarProps!.onExpandedChange(true));
      emit("keyboardWillShow");
      expect(mockBarProps!.keyboardVisible).toBe(true);
      expect(mockBarProps!.expanded).toBe(true);

      rendered.unmount();
      expect(Object.values(listeners).flat()).toHaveLength(0);
    } finally {
      listeners = {};
      jest.restoreAllMocks();
    }
  });

  it("brings the keyboard up and puts it away from the key rows", async () => {
    const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => undefined);
    const rendered = await openAttached();
    mockSurfaceFocus.mockClear();

    act(() => mockBarProps!.onShowKeyboard());
    expect(mockSurfaceFocus).toHaveBeenCalledTimes(1);

    act(() => mockBarProps!.onDismissKeyboard());
    expect(mockSurfaceBlur).toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalled();
    rendered.unmount();
    dismiss.mockRestore();
  });

  it("offers Continue here while following a terminal owned by another device", async () => {
    const rendered = render(<TerminalSessionScreen />);
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    const options = mockConnect.mock.calls[0]?.[0] as {
      onMessage: (frame: { type: string; canonicalSize?: { cols: number; rows: number } }) => void;
    };

    act(() => {
      options.onMessage({ type: "attached", canonicalSize: { cols: 100, rows: 30 } });
      options.onMessage({ type: "lease-revoked" });
    });

    expect(screen.getByText("Live on another device.")).toBeTruthy();
    fireEvent.press(screen.getByText("Continue here"));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2));
    rendered.unmount();
  });
});
