import type { ReactNode } from "react";

const mockPush = jest.fn();
const mockUseComputerDirectory = jest.fn();
const mockCreateFolder = jest.fn();
const mockCreateFile = jest.fn();
const mockRefreshDirectory = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("@/lib/queries/use-computer-directory", () => ({
  useComputerDirectory: (...args: unknown[]) => mockUseComputerDirectory(...args),
}));

jest.mock("@expo/ui", () => {
  const React = jest.requireActual("react") as typeof import("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: ({
      children,
      isPresented,
      onDismiss,
    }: {
      children: ReactNode;
      isPresented: boolean;
      onDismiss: () => void;
    }) => {
      const wasPresented = React.useRef(false);
      React.useEffect(() => {
        if (wasPresented.current && !isPresented) onDismiss();
        wasPresented.current = isPresented;
      }, [isPresented, onDismiss]);
      return isPresented ? <View testID="files-create-sheet">{children}</View> : null;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";
import FilesScreen from "../app/(drawer)/files";

describe("drawer files screen", () => {
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
      createFolder: mockCreateFolder,
      createFile: mockCreateFile,
      refresh: mockRefreshDirectory,
    });
  });

  it("holds the native refresh control open until files finish refreshing", async () => {
    let resolveRefresh: (() => void) | undefined;
    mockRefreshDirectory.mockReturnValue(new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));
    render(<FilesScreen />);

    React.act(() => screen.getByTestId("page-refresh-control").props.onRefresh());

    expect(mockRefreshDirectory).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("page-refresh-control").props.refreshing).toBe(true);

    await React.act(async () => resolveRefresh?.());
    expect(screen.getByTestId("page-refresh-control").props.refreshing).toBe(false);
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

  it("shows the create-folder action as a floating action button", () => {
    render(<FilesScreen />);

    expect(
      NativeStyleSheet.flatten(screen.getByLabelText("Create").props.style),
    ).toMatchObject({
      position: "absolute",
      right: 20,
      bottom: 24,
      width: 48,
      height: 48,
      borderWidth: 1,
      borderRadius: 999,
      backgroundColor: "#2B3715",
      boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 8px 16px rgba(51, 46, 36, 0.10)",
    });
    expect(screen.getByTestId("create-folder-icon")).toBeTruthy();
  });

  it("opens a sheet with new-folder and new-file options", () => {
    render(<FilesScreen />);

    expect(screen.queryByTestId("files-create-sheet")).toBeNull();
    fireEvent.press(screen.getByLabelText("Create"));

    expect(screen.getByTestId("files-create-sheet")).toBeTruthy();
    expect(screen.getByLabelText("New folder")).toBeTruthy();
    expect(screen.getByLabelText("New file")).toBeTruthy();
    expect(
      NativeStyleSheet.flatten(screen.getByText("New folder").props.style),
    ).toMatchObject({ fontSize: 18 });
    expect(
      NativeStyleSheet.flatten(screen.getByLabelText("New folder").props.style),
    ).toMatchObject({ alignSelf: "stretch" });
    expect(
      NativeStyleSheet.flatten(screen.getAllByTestId("files-create-divider")[0].props.style),
    ).toMatchObject({
      alignSelf: "stretch",
      borderTopWidth: NativeStyleSheet.hairlineWidth,
      borderTopColor: "#C8C6C6",
    });
  });

  it("pushes a folder naming screen and shows progress in its FAB", async () => {
    let resolveCreate: (() => void) | undefined;
    mockCreateFolder.mockImplementation(() => new Promise<void>((resolve) => {
      resolveCreate = resolve;
    }));
    render(<FilesScreen />);

    fireEvent.press(screen.getByLabelText("Create"));
    fireEvent.press(screen.getByLabelText("New folder"));
    expect(screen.getByTestId("files-create-sheet")).toBeTruthy();
    expect(screen.getByText("Name folder")).toBeTruthy();
    expect(screen.getByLabelText("Back to creation options")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("New folder name"), "Work");
    const confirmButton = screen.getByLabelText("Create folder");
    expect(NativeStyleSheet.flatten(confirmButton.props.style)).toMatchObject({
      position: "relative",
      width: 48,
      height: 48,
      borderRadius: 999,
      backgroundColor: "#2B3715",
    });
    expect(screen.getByTestId("create-folder-submit-icon")).toBeTruthy();
    fireEvent.press(confirmButton);

    expect(mockCreateFolder).toHaveBeenCalledWith("Work");
    expect(screen.getByLabelText("New folder name")).toBeTruthy();
    expect(screen.getByTestId("create-folder-submit-loading")).toBeTruthy();
    expect(screen.getByLabelText("Create folder").props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
    expect(screen.getByTestId("files-create-sheet")).toBeTruthy();

    await React.act(async () => resolveCreate?.());

    expect(screen.queryByTestId("files-create-sheet")).toBeNull();
  });

  it("keeps the naming sheet open and restores its submit FAB after a failed request", async () => {
    mockCreateFolder.mockRejectedValue(new Error("request failed"));
    render(<FilesScreen />);

    fireEvent.press(screen.getByLabelText("Create"));
    fireEvent.press(screen.getByLabelText("New folder"));
    fireEvent.changeText(screen.getByLabelText("New folder name"), "Work");
    await React.act(async () => {
      fireEvent.press(screen.getByLabelText("Create folder"));
    });

    expect(screen.getByLabelText("New folder name")).toBeTruthy();
    expect(screen.getByText("Could not create folder. Try again.")).toBeTruthy();
    expect(screen.queryByTestId("create-folder-submit-loading")).toBeNull();
    expect(screen.getByTestId("create-folder-submit-icon")).toBeTruthy();
    expect(screen.getByTestId("files-create-sheet")).toBeTruthy();
  });

  it("creates a file through the matching sheet screen", async () => {
    mockCreateFile.mockResolvedValue(undefined);
    render(<FilesScreen />);

    fireEvent.press(screen.getByLabelText("Create"));
    fireEvent.press(screen.getByLabelText("New file"));
    expect(screen.getByText("Name file")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("New file name"), "notes.md");
    fireEvent.press(screen.getByLabelText("Create file"));
    await React.act(async () => undefined);

    expect(mockCreateFile).toHaveBeenCalledWith("notes.md");
    expect(screen.queryByTestId("files-create-sheet")).toBeNull();
  });

  it("returns from the naming screen to the creation options", () => {
    render(<FilesScreen />);

    fireEvent.press(screen.getByLabelText("Create"));
    fireEvent.press(screen.getByLabelText("New file"));
    fireEvent.press(screen.getByLabelText("Back to creation options"));

    expect(screen.getByLabelText("New folder")).toBeTruthy();
    expect(screen.getByLabelText("New file")).toBeTruthy();
    expect(screen.queryByLabelText("New file name")).toBeNull();
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

  it("shows a centered empty state after an empty directory finishes loading", () => {
    mockUseComputerDirectory.mockReturnValue({
      computer: { handle: "solar-vale" },
      entries: [],
      isPending: false,
      isError: false,
      createFolder: mockCreateFolder,
      createFile: mockCreateFile,
    });

    render(<FilesScreen />);

    expect(screen.getByTestId("empty-folder-state")).toBeTruthy();
    expect(screen.getByTestId("empty-folder-icon")).toBeTruthy();
    expect(screen.getByText("this folder is currently empty")).toBeTruthy();
    expect(NativeStyleSheet.flatten(screen.getByTestId("empty-folder-state").props.style)).toMatchObject({
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    });
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
      screen.getByTestId("page-content").props.style,
      screen.getByTestId("page-heading").props.style,
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
