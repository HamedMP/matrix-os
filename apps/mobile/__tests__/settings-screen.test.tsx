const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSignOut = jest.fn(() => Promise.resolve());

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ signOut: mockSignOut }),
}));

jest.mock("@/lib/terminal-scrollback", () => ({
  clearAllScrollback: jest.fn(),
}));

jest.mock("@/lib/analytics", () => ({
  resetAnalytics: jest.fn(),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Alert } from "react-native";

import SettingsScreen from "../app/(drawer)/settings";

describe("drawer settings hub", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["System", "/settings-detail/system"],
    ["Account", "/settings-detail/account"],
    ["App settings", "/settings-detail/app-settings"],
    ["Billing", "/settings-detail/billing"],
    ["Help", "/settings-detail/help"],
  ])("opens %s in the settings modal stack", (label, route) => {
    render(<SettingsScreen />);

    fireEvent.press(screen.getByLabelText(`Open ${label}`));

    expect(mockPush).toHaveBeenCalledWith(route);
  });

  it("confirms before signing out", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(
      (_title, _message, buttons) => buttons?.find((button) => button.style === "destructive")?.onPress?.(),
    );
    render(<SettingsScreen />);

    fireEvent.press(screen.getByLabelText("Sign out"));

    expect(alert).toHaveBeenCalledWith(
      "Sign out?",
      expect.any(String),
      expect.any(Array),
    );
    await Promise.resolve();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/sign-in");
  });
});
