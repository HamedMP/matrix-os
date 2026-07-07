jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const mockReplace = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import CanvasEntryScreen from "../app/canvas";
import { MOBILE_SHELL_STATE_STORAGE_KEY } from "../lib/mobile-shell-state";

describe("CanvasEntryScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
  });

  it("shows an explicit native Canvas unavailable state and returns to the app launcher", async () => {
    render(<CanvasEntryScreen />);

    expect(screen.getByText("Canvas opens best in the browser shell")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Remember Canvas entry"));

    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_SHELL_STATE_STORAGE_KEY,
      expect.stringContaining("\"mode\":\"canvas\""),
    ));

    fireEvent.press(screen.getByLabelText("Apps"));
    expect(mockReplace).toHaveBeenCalledWith("/(tabs)/apps");
  });
});
