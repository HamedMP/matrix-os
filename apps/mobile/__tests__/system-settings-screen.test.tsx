const mockUseSettingsSystemInfo = jest.fn();

jest.mock("@/lib/queries/use-settings-system-info", () => ({
  useSettingsSystemInfo: () => mockUseSettingsSystemInfo(),
}));

import React from "react";
import { render, screen } from "@testing-library/react-native";

import SystemSettingsScreen from "../app/settings-detail/system";

describe("system settings", () => {
  it("names the release without calling every computer a VPS (ENG-520: free computers are not VPSes)", () => {
    mockUseSettingsSystemInfo.mockReturnValue({ computer: null, systemInfo: null, isPending: false, isError: true });
    render(<SystemSettingsScreen />);

    expect(screen.getByText("Matrix release version")).toBeTruthy();
    expect(screen.getByText("Some computer information could not be loaded.")).toBeTruthy();
    expect(screen.queryByText(/VPS/)).toBeNull();
  });
});
