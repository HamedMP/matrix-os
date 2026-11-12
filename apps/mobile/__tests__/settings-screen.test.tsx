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

import SettingsScreen from "../app/(drawer)/(tabs)/settings";

describe("drawer settings hub", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["System", "/settings-detail/system"],
    ["Account", "/settings-detail/account"],
    ["App settings", "/settings-detail/app-settings"],
    ["Connect Apps", "/settings-detail/connect-apps"],
    ["Billing", "/settings-detail/billing"],
    ["Help", "/settings-detail/help"],
  ])("opens %s in the settings modal stack", (label, route) => {
    render(<SettingsScreen />);

    fireEvent.press(screen.getByLabelText(`Open ${label}`));

    expect(mockPush).toHaveBeenCalledWith(route);
  });

  it("lists Connect Apps with the desktop's Settings sections, before Billing", () => {
    render(<SettingsScreen />);

    expect(screen.getAllByLabelText(/^(Open .+|Sign out)$/).map((row) => row.props.accessibilityLabel)).toEqual([
      "Open System",
      "Open Account",
      "Open App settings",
      "Open Connect Apps",
      "Open Billing",
      "Open Help",
      "Sign out",
    ]);
    expect(screen.getByText("Accounts and tools Matrix can use")).toBeTruthy();
  });

  it("says where the privacy policy lives so it is findable from the hub", () => {
    render(<SettingsScreen />);

    expect(screen.getByText("Docs, support, privacy, and terms")).toBeTruthy();
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
