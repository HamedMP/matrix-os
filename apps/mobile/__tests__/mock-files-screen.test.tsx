const mockPush = jest.fn();
const mockUseComputerDirectory = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("@/lib/queries/use-computer-directory", () => ({
  useComputerDirectory: (...args: unknown[]) => mockUseComputerDirectory(...args),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";
import FilesScreen from "../app/(drawer)/files";

describe("mock files screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseComputerDirectory.mockReturnValue({
      computer: { handle: "solar-vale" },
      entries: [
        { name: "Projects", type: "directory" },
        { name: "Documents", type: "directory" },
        { name: "README.md", type: "file" },
      ],
      isPending: false,
      isError: false,
    });
  });

  it("opens a folder as one modal workspace", () => {
    render(<FilesScreen />);

    fireEvent.press(screen.getByLabelText("Open Projects folder"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/file-browser",
      params: { folder: "Projects" },
    });
  });

  it("shows folders loaded from the selected computer", () => {
    render(<FilesScreen />);

    expect(mockUseComputerDirectory).toHaveBeenCalledWith("");
    expect(screen.getByText("Everything on solar-vale")).toBeTruthy();
    expect(screen.getByText("3 items")).toBeTruthy();
    expect(screen.getByLabelText("Open Projects folder")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.getByTestId("grid-tile-icon-README.md")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Open README.md file"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/file-browser/file",
      params: { name: "README.md", path: "README.md" },
    });
    expect(screen.queryByLabelText("Open Photos folder")).toBeNull();
  });

  it("renders folder icons without a background by default", () => {
    render(<FilesScreen />);

    expect(
      NativeStyleSheet.flatten(screen.getByTestId("grid-tile-icon-Projects").props.style),
    ).toMatchObject({ backgroundColor: "transparent" });
  });

  it("shows three skeleton tiles while the root directory is loading", () => {
    mockUseComputerDirectory.mockReturnValue({
      computer: { handle: "solar-vale" },
      entries: [],
      isPending: true,
      isError: false,
    });

    render(<FilesScreen />);

    expect(screen.getAllByTestId("file-tile-skeleton")).toHaveLength(3);
    expect(screen.getAllByTestId("file-tile-skeleton-shimmer")).toHaveLength(3);
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
