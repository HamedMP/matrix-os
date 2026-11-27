const mockUseSettingsBilling = jest.fn();
const mockOpenPortal = jest.fn();

jest.mock("@/lib/queries/use-settings-billing", () => ({
  useSettingsBilling: () => mockUseSettingsBilling(),
}));

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking, Platform } from "react-native";

import { FREE_PLAN_COPY } from "@matrix-os/contracts/free-plan-copy";
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
      const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
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

  describe("on the Free plan (ENG-520)", () => {
    function freeBillingState() {
      return {
        billing: { entitlement: { source: "free", planSlug: "matrix_free", status: "active", portalAvailable: false, billingInterval: null } },
        isPending: false,
        isError: false,
        openPortal: mockOpenPortal,
        isOpeningPortal: false,
      };
    }

    it.each(["ios", "android"] as const)("names the plan and the sleep rule, with no purchase copy, in the %s store build", (os) => {
      jest.replaceProperty(Platform, "OS", os);
      mockUseSettingsBilling.mockReturnValue(freeBillingState());
      render(<BillingSettingsScreen />);

      expect(screen.getByText("Free")).toBeTruthy();
      expect(screen.getByText(FREE_PLAN_COPY.sleep)).toBeTruthy();
      expect(screen.queryByText(/matrix_free/)).toBeNull();
      expect(screen.queryByText(/browser|pricing|upgrade|buy|purchase|paid/i)).toBeNull();
    });

    it("offers paid plans in the web build", async () => {
      jest.replaceProperty(Platform, "OS", "web");
      const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
      mockUseSettingsBilling.mockReturnValue(freeBillingState());
      render(<BillingSettingsScreen />);

      expect(screen.getByText(FREE_PLAN_COPY.upgrade)).toBeTruthy();
      fireEvent.press(screen.getByLabelText("Change plan"));
      await waitFor(() => expect(openUrl).toHaveBeenCalledWith(PRICING_URL));
      expect(mockOpenPortal).not.toHaveBeenCalled();
    });
  });

  describe("in the web build", () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, "OS", "web");
    });

    it("opens billing management for an override-backed account with a linked customer", async () => {
      const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
      render(<BillingSettingsScreen />);

      fireEvent.press(screen.getByLabelText("Change plan"));

      await waitFor(() => {
        expect(mockOpenPortal).toHaveBeenCalledTimes(1);
        expect(openUrl).toHaveBeenCalledWith(PORTAL_URL);
      });
      expect(openUrl).not.toHaveBeenCalledWith(PRICING_URL);
    });

    it("opens pricing when billing management is unavailable", async () => {
      const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
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
