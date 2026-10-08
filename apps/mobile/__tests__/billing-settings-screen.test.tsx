const mockUseSettingsBilling = jest.fn();
const mockOpenPortal = jest.fn();

jest.mock("@/lib/queries/use-settings-billing", () => ({
  useSettingsBilling: () => mockUseSettingsBilling(),
}));

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking, Platform } from "react-native";

import BillingSettingsScreen from "../app/settings-detail/billing";

const PRICING_URL = "https://matrix-os.com/pricing";
const PORTAL_URL = "https://billing.stripe.test/session";

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

describe("billing settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenPortal.mockResolvedValue(PORTAL_URL);
    mockUseSettingsBilling.mockReturnValue(settingsBillingState(true));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(["ios", "android"] as const)("in the %s store build", (os) => {
    beforeEach(() => {
      jest.replaceProperty(Platform, "OS", os);
    });

    it.each([true, false])("shows the current plan read-only with no Change plan row (portalAvailable=%s)", (portalAvailable) => {
      const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
      mockUseSettingsBilling.mockReturnValue(settingsBillingState(portalAvailable));
      render(<BillingSettingsScreen />);

      expect(screen.getByText("Current plan")).toBeTruthy();
      expect(screen.getByText("Builder")).toBeTruthy();
      expect(screen.queryByLabelText("Change plan")).toBeNull();
      expect(screen.queryByText("Change plan")).toBeNull();
      expect(screen.queryByText(/browser|pricing|upgrade|buy|purchase/i)).toBeNull();
      expect(mockOpenPortal).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalledWith(PRICING_URL);
      expect(openUrl).not.toHaveBeenCalledWith(PORTAL_URL);
    });
  });

  describe("in the web build", () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, "OS", "web");
    });

    it("opens billing management for an override-backed account with a linked customer", async () => {
      const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
      render(<BillingSettingsScreen />);

      fireEvent.press(screen.getByLabelText("Change plan"));

      await waitFor(() => {
        expect(mockOpenPortal).toHaveBeenCalledTimes(1);
        expect(openUrl).toHaveBeenCalledWith(PORTAL_URL);
      });
      expect(openUrl).not.toHaveBeenCalledWith(PRICING_URL);
    });

    it("opens pricing when billing management is unavailable", async () => {
      const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
      mockUseSettingsBilling.mockReturnValue(settingsBillingState(false));
      render(<BillingSettingsScreen />);

      fireEvent.press(screen.getByLabelText("Change plan"));

      await waitFor(() => {
        expect(openUrl).toHaveBeenCalledWith(PRICING_URL);
      });
      expect(mockOpenPortal).not.toHaveBeenCalled();
    });
  });
});
