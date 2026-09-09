const mockConnect = jest.fn();
const mockDetach = jest.fn();
const mockSendInput = jest.fn(() => true);
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

jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ session: "main" }),
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
    TerminalSurface: React.forwardRef((props: { onInput: (data: string) => void }, ref: React.Ref<unknown>) => {
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
      );
    }),
  };
});

jest.mock("@/components/TerminalControlBar", () => ({
  TerminalControlBar: () => null,
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import TerminalSessionScreen from "../app/terminal-session/[session]";

describe("live terminal session modal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue({
      detach: mockDetach,
      sendInput: mockSendInput,
      resize: mockResize,
      close: jest.fn(),
    });
  });

  it("attaches the terminal surface to the selected VPS session", async () => {
    const rendered = render(<TerminalSessionScreen />);

    await waitFor(() => expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "main",
      onMessage: expect.any(Function),
      onStatus: expect.any(Function),
    })));

    const options = mockConnect.mock.calls[0]?.[0] as {
      onMessage: (frame: { type: string; data?: string; replay?: string; sessionId?: string; canonicalSize?: { cols: number; rows: number } | null }) => void;
    };
    options.onMessage({ type: "attached", sessionId: "main", replay: "ready", canonicalSize: null });
    options.onMessage({ type: "output", data: "\nhello" });
    expect(mockSurfaceClear).toHaveBeenCalled();
    expect(mockSurfaceWrite).toHaveBeenCalledWith("ready");
    expect(mockSurfaceWrite).toHaveBeenCalledWith("\nhello");

    fireEvent.press(screen.getByLabelText("Type terminal input"));
    expect(mockSendInput).toHaveBeenCalledWith("a");

    rendered.unmount();
    expect(mockDetach).toHaveBeenCalled();
  });

  it("stops showing an indefinite loader when the socket handshake never opens", async () => {
    jest.useFakeTimers();
    render(<TerminalSessionScreen />);

    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    act(() => jest.advanceTimersByTime(15_000));

    expect(screen.getByText("Terminal unavailable. Try again.")).toBeTruthy();
    jest.useRealTimers();
  });
});
