const mockDismiss = jest.fn();
let mockScreenOptions: Record<string, unknown> | undefined;

jest.mock("expo-router", () => ({
  Stack: ({ screenOptions }: { screenOptions?: Record<string, unknown> }) => {
    mockScreenOptions = screenOptions;
    return null;
  },
  useRouter: () => ({ dismiss: mockDismiss }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import AppPreviewLayout from "../app/app-preview/_layout";

type HeaderRenderer = (props: { options: { title?: string } }) => React.ReactNode;

function renderHeader(title?: string) {
  render(<AppPreviewLayout />);
  const header = mockScreenOptions?.header as HeaderRenderer | undefined;
  expect(header).toBeInstanceOf(Function);
  render(<>{header?.({ options: { title } })}</>);
}

describe("app preview modal navigation", () => {
  beforeEach(() => {
    mockDismiss.mockClear();
    mockScreenOptions = undefined;
  });

  it("replaces the native navigation bar with a compact bar under the status bar", () => {
    renderHeader("Gym Tracker");

    const header = NativeStyleSheet.flatten(screen.getByTestId("app-preview-header").props.style);
    expect(header.paddingTop).toBe(62);

    const bar = NativeStyleSheet.flatten(screen.getByTestId("app-preview-header-bar").props.style);
    expect(bar.height).toBe(36);

    // The native bar's own controls would render a second, taller bar.
    expect(mockScreenOptions?.headerLeft).toBeUndefined();
    expect(mockScreenOptions?.unstable_headerLeftItems).toBeUndefined();
  });

  it("keeps the app name on one line", () => {
    renderHeader("Gym Tracker");

    const title = screen.getByText("Gym Tracker");
    expect(title.props.numberOfLines).toBe(1);
    expect(title.props.accessibilityRole).toBe("header");
  });

  it("shows a transparent HugeIcons close control", () => {
    renderHeader("Gym Tracker");

    const button = screen.getByLabelText("Close app");
    const style = NativeStyleSheet.flatten(button.props.style);
    expect(style.backgroundColor).toBe("transparent");
    expect(style.borderWidth).toBeUndefined();
    expect(screen.getByTestId("app-preview-close-icon")).toBeTruthy();

    fireEvent.press(button);
    expect(mockDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the close control's touch target at 44pt in the shorter bar", () => {
    renderHeader("Gym Tracker");

    const button = screen.getByLabelText("Close app");
    const style = NativeStyleSheet.flatten(button.props.style);
    const slop = button.props.hitSlop as { top: number; bottom: number; left: number; right: number };
    expect(style.height + slop.top + slop.bottom).toBeGreaterThanOrEqual(44);
    expect(style.width + slop.left + slop.right).toBeGreaterThanOrEqual(44);
    // Slop below the bar would land on the app's own content.
    expect(slop.bottom).toBe(0);
  });
});
