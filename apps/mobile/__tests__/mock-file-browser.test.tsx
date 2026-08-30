const mockPush = jest.fn();
const mockParams = { folder: "Projects", path: undefined as string | string[] | undefined };

jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: mockPush, dismiss: jest.fn() }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import FileBrowserScreen from "../app/file-browser/index";

describe("file browser modal stack", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("pushes deeper folders inside the existing modal stack", () => {
    render(<FileBrowserScreen />);

    fireEvent.press(screen.getByLabelText("Open matrix-os folder"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/file-browser/[...path]",
      params: { path: ["Projects", "matrix-os"] },
    });
  });
});
