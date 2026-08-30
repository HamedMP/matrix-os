const mockPush = jest.fn();
const mockDismiss = jest.fn();
const mockBack = jest.fn();
const mockParams = { folder: "Projects", path: undefined as string | string[] | undefined };
const mockStackScreens: Array<{ name?: string; options?: Record<string, unknown> }> = [];

jest.mock("expo-router", () => ({
  Stack: Object.assign(
    ({ children }: { children: React.ReactNode }) => children,
    {
      Screen: ({ name, options }: { name?: string; options?: Record<string, unknown> }) => {
        mockStackScreens.push({ name, options });
        return null;
      },
    },
  ),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: mockPush, dismiss: mockDismiss, back: mockBack }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";
import FileBrowserScreen from "../app/file-browser/index";
import FileBrowserLayout from "../app/file-browser/_layout";

describe("file browser modal stack", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStackScreens.length = 0;
  });

  it("pushes deeper folders inside the existing modal stack", () => {
    render(<FileBrowserScreen />);

    expect(screen.queryByText("LOCATION")).toBeNull();
    expect(screen.queryByText("Projects")).toBeNull();

    const first = NativeStyleSheet.flatten(screen.getByLabelText("Open matrix-os folder").props.style);
    const second = NativeStyleSheet.flatten(screen.getByLabelText("Open mobile-lab folder").props.style);
    expect(first.backgroundColor).toBe(second.backgroundColor);
    expect(first.borderColor).toBe(second.borderColor);

    fireEvent.press(screen.getByLabelText("Open matrix-os folder"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/file-browser/[...path]",
      params: { path: ["Projects", "matrix-os"] },
    });
  });

  it("uses transparent HugeIcons controls for close and back", () => {
    render(<FileBrowserLayout />);

    const rootOptions = mockStackScreens.find((route) => route.name === "index")?.options;
    const nestedOptions = mockStackScreens.find((route) => route.name === "[...path]")?.options;
    const RootHeaderItems = rootOptions?.unstable_headerLeftItems as (() => Array<{
      element: React.ReactNode;
      hidesSharedBackground?: boolean;
    }>) | undefined;
    const NestedHeaderItems = nestedOptions?.unstable_headerLeftItems as (() => Array<{
      element: React.ReactNode;
      hidesSharedBackground?: boolean;
    }>) | undefined;
    const rootItems = RootHeaderItems?.() ?? [];
    const nestedItems = NestedHeaderItems?.() ?? [];

    expect(rootItems[0]?.hidesSharedBackground).toBe(true);
    expect(nestedItems[0]?.hidesSharedBackground).toBe(true);

    render(
      <>
        {rootItems[0]?.element}
        {nestedItems[0]?.element}
      </>,
    );

    for (const label of ["Close file browser", "Back to previous folder"]) {
      const style = NativeStyleSheet.flatten(screen.getByLabelText(label).props.style);
      expect(style.backgroundColor).toBe("transparent");
      expect(style.borderWidth).toBeUndefined();
      expect(style.borderColor).toBeUndefined();
    }
    expect(screen.getByTestId("file-browser-close-icon")).toBeTruthy();
    expect(screen.getByTestId("file-browser-back-icon")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Close file browser"));
    fireEvent.press(screen.getByLabelText("Back to previous folder"));
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
