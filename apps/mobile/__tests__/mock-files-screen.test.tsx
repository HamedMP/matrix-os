const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
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
});
