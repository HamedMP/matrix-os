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

    fireEvent.press(screen.getByLabelText("Manage billing"));

    await waitFor(() => {
      expect(mockOpenPortal).toHaveBeenCalledTimes(1);
      expect(openUrl).toHaveBeenCalledWith("https://billing.stripe.test/session");
    });
    expect(openUrl).not.toHaveBeenCalledWith("https://matrix-os.com/pricing");
  });

  it("does not offer subscription actions for team access without a customer", () => {
    mockUseSettingsBilling.mockReturnValue(settingsBillingState(false));
    render(<BillingSettingsScreen />);
    expect(screen.queryByLabelText("Manage billing")).toBeNull();
    expect(screen.queryByLabelText("View plans")).toBeNull();
    expect(mockOpenPortal).not.toHaveBeenCalled();
  });

  it("shows team access without calling it an internal subscription", () => {
    mockUseSettingsBilling.mockReturnValue(settingsBillingState(false));
    render(<BillingSettingsScreen />);
    expect(screen.getByText("Team-provided access")).toBeTruthy();
    expect(screen.queryByText("Monthly")).toBeNull();
  });

  it("shows the paid subscription under an override", () => {
    const state = settingsBillingState(true);
    mockUseSettingsBilling.mockReturnValue({ ...state, billing: {
      ...state.billing, management: {
        portalAvailable: true, runtimeSlot: "primary", computerCount: 1, runtimePlacement: null,
        subscription: { planSlug: "matrix_max", status: "active", billingInterval: "annual", recurringPrice: null,
          currentPeriodEnd: null, trialEndsAt: null, trialConvertedAt: null, firstTrialPaymentFailedAt: null },
      },
    } });
    render(<BillingSettingsScreen />);
    expect(screen.getByText("Max")).toBeTruthy();
    expect(screen.getByText("Annual")).toBeTruthy();
  });

});
