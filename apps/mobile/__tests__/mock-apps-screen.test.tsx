const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import AppsScreen from "../app/(drawer)/apps";

describe("mock apps screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens an app preview", () => {
    render(<AppsScreen />);

    const first = NativeStyleSheet.flatten(screen.getByLabelText("Open Chess").props.style);
    const second = NativeStyleSheet.flatten(screen.getByLabelText("Open Notes").props.style);
    expect(first.backgroundColor).toBe(second.backgroundColor);
    expect(first.borderColor).toBe(second.borderColor);

    fireEvent.press(screen.getByLabelText("Open Chess"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/app-preview/[app]",
      params: { app: "Chess" },
    });
  });

  it("uses spacers instead of vertical padding or margins", () => {
    render(<AppsScreen />);

    const styles = [
      screen.getByTestId("mock-page-content").props.style,
      screen.getByTestId("mock-page-heading").props.style,
      screen.getByLabelText("Search apps").props.style,
      screen.getByLabelText("Open Chess").props.style,
    ].map(NativeStyleSheet.flatten);

    for (const style of styles) {
      expect(style.paddingTop).toBeUndefined();
      expect(style.paddingBottom).toBeUndefined();
      expect(style.paddingVertical).toBeUndefined();
      expect(style.marginTop).toBeUndefined();
      expect(style.marginBottom).toBeUndefined();
      expect(style.marginVertical).toBeUndefined();
    }
  });
});
