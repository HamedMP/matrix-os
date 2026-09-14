const mockUseSettingsBilling = jest.fn();
const mockOpenPortal = jest.fn();

jest.mock("@/lib/queries/use-settings-billing", () => ({
  useSettingsBilling: () => mockUseSettingsBilling(),
}));

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";

import BillingSettingsScreen from "../app/settings-detail/billing";

const overrideEntitlement = {
  source: "override",
  planSlug: "matrix_builder",
  status: "active",
  portalAvailable: true,
  billingInterval: null,
};

function settingsBillingState(portalAvailable: boolean) {
  return {
    billing: {
      entitlement: { ...overrideEntitlement, portalAvailable },
    },
    isPending: false,
    isError: false,
    openPortal: mockOpenPortal,
    isOpeningPortal: false,
  };
}

describe("native mobile billing settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenPortal.mockResolvedValue("https://billing.stripe.test/session");
    mockUseSettingsBilling.mockReturnValue(settingsBillingState(true));
  });

  it("opens billing management for an override-backed account with a linked customer", async () => {
    const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    render(<BillingSettingsScreen />);

    fireEvent.press(screen.getByLabelText("Change plan"));

    await waitFor(() => {
      expect(mockOpenPortal).toHaveBeenCalledTimes(1);
      expect(openUrl).toHaveBeenCalledWith("https://billing.stripe.test/session");
    });
    expect(openUrl).not.toHaveBeenCalledWith("https://matrix-os.com/pricing");
  });

  it("opens pricing when billing management is unavailable", async () => {
    const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    mockUseSettingsBilling.mockReturnValue(settingsBillingState(false));
    render(<BillingSettingsScreen />);

    fireEvent.press(screen.getByLabelText("Change plan"));

    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith("https://matrix-os.com/pricing");
    });
    expect(mockOpenPortal).not.toHaveBeenCalled();
  });
});
