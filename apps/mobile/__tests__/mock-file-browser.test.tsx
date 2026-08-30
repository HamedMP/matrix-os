const mockPush = jest.fn();
const mockDismiss = jest.fn();
const mockBack = jest.fn();
const mockParams = {
  folder: "Projects",
  path: undefined as string | string[] | undefined,
  name: undefined as string | string[] | undefined,
};
const mockStackScreens: Array<{ name?: string; options?: Record<string, unknown> }> = [];
const mockUseComputerDirectory = jest.fn();
const mockUseComputerFilePreview = jest.fn();

jest.mock("expo-image", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    Image: (props: Record<string, unknown>) => React.createElement(View, {
      testID: "file-preview-image",
      ...props,
    }),
  };
});

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

jest.mock("@/lib/queries/use-computer-directory", () => ({
  useComputerDirectory: (...args: unknown[]) => mockUseComputerDirectory(...args),
}));

jest.mock("@/lib/queries/use-computer-file-preview", () => ({
  useComputerFilePreview: (...args: unknown[]) => mockUseComputerFilePreview(...args),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { ScrollView, StyleSheet as NativeStyleSheet } from "react-native";
import FileBrowserScreen from "../app/file-browser/index";
import FileBrowserLayout from "../app/file-browser/_layout";
import FileDetailScreen from "../app/file-browser/file";

describe("file browser modal stack", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStackScreens.length = 0;
    mockParams.folder = "Projects";
    mockParams.path = undefined;
    mockParams.name = undefined;
    mockUseComputerDirectory.mockReturnValue({
      computer: { handle: "solar-vale" },
      entries: [
        { name: "matrix-os", type: "directory" },
        { name: "mobile-lab", type: "directory" },
        { name: "notes.md", type: "file" },
      ],
      isPending: false,
      isError: false,
    });
    mockUseComputerFilePreview.mockReturnValue({
      preview: { kind: "text", content: "Hello from the real file" },
      isPending: false,
      isError: false,
    });
  });

  it("pushes deeper folders inside the existing modal stack", () => {
    const { UNSAFE_getByType } = render(<FileBrowserScreen />);

    expect(mockUseComputerDirectory).toHaveBeenCalledWith("Projects");
    expect(UNSAFE_getByType(ScrollView)).toBeTruthy();

    expect(screen.queryByText("LOCATION")).toBeNull();
    expect(screen.queryByText("Projects")).toBeNull();
    expect(screen.getByText("notes.md")).toBeTruthy();

    const first = NativeStyleSheet.flatten(screen.getByLabelText("Open matrix-os folder").props.style);
    const second = NativeStyleSheet.flatten(screen.getByLabelText("Open mobile-lab folder").props.style);
    expect(first.backgroundColor).toBe(second.backgroundColor);
    expect(first.borderColor).toBe(second.borderColor);

    fireEvent.press(screen.getByLabelText("Open matrix-os folder"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/file-browser/[...path]",
      params: { path: ["Projects", "matrix-os"] },
    });

    fireEvent.press(screen.getByLabelText("Open notes.md file"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/file-browser/file",
      params: { name: "notes.md", path: "Projects/notes.md" },
    });
  });

  it("uses the modal title for the file name and gives the preview the full screen", () => {
    mockParams.name = "notes.md";
    mockParams.path = "Projects/notes.md";

    render(<FileDetailScreen />);

    expect(mockUseComputerFilePreview).toHaveBeenCalledWith("Projects/notes.md");
    expect(mockStackScreens.at(-1)?.options?.title).toBe("notes.md");
    expect(screen.queryByText("notes.md")).toBeNull();
    expect(screen.getByText("Hello from the real file")).toBeTruthy();
    expect(screen.queryByText("LOCATION")).toBeNull();
    expect(NativeStyleSheet.flatten(screen.getByTestId("file-preview-screen").props.style).flex).toBe(1);
  });

  it("shows three skeleton tiles while a folder modal is loading", () => {
    mockUseComputerDirectory.mockReturnValue({
      computer: { handle: "solar-vale" },
      entries: [],
      isPending: true,
      isError: false,
    });

    render(<FileBrowserScreen />);

    expect(screen.getAllByTestId("file-tile-skeleton")).toHaveLength(3);
  });

  it("renders authenticated image previews natively", () => {
    mockParams.name = "photo.png";
    mockParams.path = "Images/photo.png";
    mockUseComputerFilePreview.mockReturnValue({
      preview: {
        kind: "image",
        uri: "https://app.matrix-os.com/vm/solar-vale/files/Images/photo.png",
        authorization: "Bearer clerk-token",
      },
      isPending: false,
      isError: false,
    });

    render(<FileDetailScreen />);

    expect(screen.getByTestId("file-preview-image").props.source).toEqual({
      uri: "https://app.matrix-os.com/vm/solar-vale/files/Images/photo.png",
      headers: { Authorization: "Bearer clerk-token" },
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
