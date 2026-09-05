const mockDismiss = jest.fn();
let mockScreenOptions: Record<string, unknown> | undefined;

jest.mock("expo-router", () => ({
  Stack: ({ screenOptions }: { screenOptions?: Record<string, unknown> }) => {
    mockScreenOptions = screenOptions;
    return null;
  },
  useRouter: () => ({ dismiss: mockDismiss }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import TerminalSessionLayout from "../app/terminal-session/_layout";

describe("terminal modal navigation", () => {
  it("shows a transparent HugeIcons close control", () => {
    render(<TerminalSessionLayout />);

    const HeaderItems = mockScreenOptions?.unstable_headerLeftItems as (() => Array<{
      element: React.ReactNode;
      hidesSharedBackground?: boolean;
    }>) | undefined;
    const items = HeaderItems?.() ?? [];
    expect(items[0]?.hidesSharedBackground).toBe(true);
    render(<>{items[0]?.element}</>);

    const button = screen.getByLabelText("Close terminal session");
    const style = NativeStyleSheet.flatten(button.props.style);
    expect(style.backgroundColor).toBe("transparent");
    expect(style.borderWidth).toBeUndefined();
    expect(screen.getByTestId("terminal-close-icon")).toBeTruthy();

    fireEvent.press(button);
    expect(mockDismiss).toHaveBeenCalledTimes(1);
  });
});
