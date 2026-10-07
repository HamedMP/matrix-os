const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";

import HelpSettingsScreen from "../app/settings-detail/help";

describe("native mobile help settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["Open privacy policy", "https://matrix-os.com/privacy"],
    ["Open terms of service", "https://matrix-os.com/terms"],
    ["Open docs", "https://matrix-os.com/docs"],
  ])("%s opens %s", (label, url) => {
    const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    render(<HelpSettingsScreen />);

    fireEvent.press(screen.getByLabelText(label));

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(url);
  });

  it("keeps contact support inside the settings stack", () => {
    render(<HelpSettingsScreen />);

    fireEvent.press(screen.getByLabelText("Open Contact support"));

    expect(mockPush).toHaveBeenCalledWith("/settings-detail/support");
  });
});
