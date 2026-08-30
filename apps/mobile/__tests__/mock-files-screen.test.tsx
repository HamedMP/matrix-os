const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";
import FilesScreen from "../app/(drawer)/files";

describe("mock files screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens a folder as one modal workspace", () => {
    render(<FilesScreen />);

    fireEvent.press(screen.getByLabelText("Open Projects folder"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/file-browser",
      params: { folder: "Projects" },
    });
  });

  it("renders folder icons without a background by default", () => {
    render(<FilesScreen />);

    expect(
      NativeStyleSheet.flatten(screen.getByTestId("grid-tile-icon-Projects").props.style),
    ).toMatchObject({ backgroundColor: "transparent" });
  });

  it("does not mark any folder tile as active", () => {
    render(<FilesScreen />);

    const first = NativeStyleSheet.flatten(screen.getByLabelText("Open Projects folder").props.style);
    const second = NativeStyleSheet.flatten(screen.getByLabelText("Open Documents folder").props.style);

    expect(first.backgroundColor).toBe(second.backgroundColor);
    expect(first.borderColor).toBe(second.borderColor);
  });

  it("uses spacers instead of vertical padding or margins", () => {
    render(<FilesScreen />);

    const styles = [
      screen.getByTestId("mock-page-content").props.style,
      screen.getByTestId("mock-page-heading").props.style,
      screen.getByTestId("files-section-heading").props.style,
      screen.getByLabelText("Search files").props.style,
      screen.getByLabelText("Open Projects folder").props.style,
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
