// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BillingSection from "../../desktop/src/renderer/src/features/settings/sections/BillingSection";
import SettingsView from "../../desktop/src/renderer/src/features/settings/SettingsView";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const activeBilling = {
  access: { runtimeProxyAllowed: true, reason: "active" },
  entitlement: {
    source: "stripe",
    planSlug: "matrix_builder",
    status: "active",
    maxRuntimeSlots: 2,
    includedRuntimeSlots: 1,
    addonRuntimeSlots: 1,
    defaultServerType: "cpx32",
    allowedServerTypes: ["cpx22", "cpx32"],
    stripeSubscriptionId: "sub_123",
    stripePriceId: "price_123",
    gracePeriodEndsAt: null,
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    effectiveUntil: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
};

function makeApi(statusResponse: unknown) {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async () => statusResponse),
    getText: vi.fn(),
    post: vi.fn(async (path: string) => ({
      url: path === "/billing/portal" ? "https://billing.stripe.test/session" : "https://checkout.stripe.test/session",
    })),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  };
}

describe("desktop billing settings", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    window.operator = {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "state:get") return { value: { theme: "light" } };
        return { ok: true };
      }),
      on: vi.fn(() => () => undefined),
    };
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      displayName: "Ada Operator",
      imageUrl: null,
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "primary",
      api: makeApi(activeBilling) as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows billing in desktop settings navigation", () => {
    render(<SettingsView />);
    expect(screen.getByRole("button", { name: "Billing" })).not.toBeNull();
  });

  it("loads native billing status through the desktop API client", async () => {
    const api = makeApi(activeBilling);
    useConnection.setState({ api: api as never });

    render(<BillingSection />);

    await waitFor(() => expect(screen.getByText("Billing active")).not.toBeNull());
    expect(api.get).toHaveBeenCalledWith("/billing/status");
    expect(screen.getByText("Builder")).not.toBeNull();
    expect(screen.getByText("2 of 2")).not.toBeNull();
  });

  it("opens the billing portal through the platform billing route", async () => {
    const api = makeApi(activeBilling);
    useConnection.setState({ api: api as never });

    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Billing active")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Open portal/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/billing/portal", {}));
    expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", {
      url: "https://billing.stripe.test/session",
    });
  });

  it("starts checkout with the selected native billing options", async () => {
    const api = makeApi({ access: { runtimeProxyAllowed: false }, entitlement: null });
    useConnection.setState({ api: api as never });

    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Billing required")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Continue to checkout/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/billing/checkout",
        { planSlug: "matrix_builder", interval: "monthly", regionSlug: "region_fsn1" },
      ),
    );
    expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", {
      url: "https://checkout.stripe.test/session",
    });
  });
});
