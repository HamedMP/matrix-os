// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BillingSection from "../../desktop/src/renderer/src/features/settings/sections/BillingSection";
import SettingsView from "../../desktop/src/renderer/src/features/settings/SettingsView";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const activeBilling = {
  access: { runtimeProxyAllowed: true, reason: "active" },
  trialOffer: { eligible: false, durationDays: 3 },
  entitlement: {
    source: "stripe",
    planSlug: "matrix_builder",
    status: "active",
    maxRuntimeSlots: 2,
    includedRuntimeSlots: 1,
    addonRuntimeSlots: 1,
    allowedPlanSlugs: ["matrix_starter", "matrix_builder"],
    portalAvailable: true,
    billingInterval: "monthly",
    gracePeriodEndsAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialConvertedAt: null,
    firstTrialPaymentFailedAt: null,
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
    expect(screen.queryByText("Default machine")).toBeNull();
    expect(screen.queryByText(/cpx\d+/i)).toBeNull();
  });

  it("opens the billing portal through the platform billing route", async () => {
    const api = makeApi(activeBilling);
    useConnection.setState({ api: api as never });

    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Billing active")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Manage billing/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/billing/portal", {}));
    expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", {
      url: "https://billing.stripe.test/session",
    });
  });

  it("explains internally managed billing instead of hiding management", async () => {
    const api = makeApi({
      ...activeBilling,
      entitlement: { ...activeBilling.entitlement, source: "override", portalAvailable: false },
    });
    useConnection.setState({ api: api as never });
    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Billing active")).not.toBeNull());

    const button = screen.getByRole("button", { name: /Manage billing/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/managed internally/)).not.toBeNull();
    fireEvent.click(button);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("explains an unavailable portal without calling a paid account internal", async () => {
    useConnection.setState({ api: makeApi({
      ...activeBilling,
      entitlement: { ...activeBilling.entitlement, portalAvailable: false },
    }) as never });
    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Billing active")).not.toBeNull());

    expect((screen.getByRole("button", { name: /Manage billing/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Billing management is not available for this account yet/)).not.toBeNull();
    expect(screen.queryByText(/managed internally/)).toBeNull();
  });

  it("disables management while refreshing and explains a failed status check", async () => {
    const api = makeApi(activeBilling);
    useConnection.setState({ api: api as never });
    render(<BillingSection />);
    expect((screen.getByRole("button", { name: /Manage billing/i }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByText("Billing active")).not.toBeNull());
    let rejectRefresh!: (reason: Error) => void;
    api.get.mockImplementationOnce(() => new Promise((_, reject) => { rejectRefresh = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const button = screen.getByRole("button", { name: /Manage billing/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(api.post).not.toHaveBeenCalled();
    rejectRefresh(new Error("status unavailable"));
    await waitFor(() => expect(screen.getByText(/Refresh your billing status/)).not.toBeNull());
    expect(button.disabled).toBe(true);
    expect(screen.queryByText(/managed internally/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("prevents duplicate portal requests while opening the browser", async () => {
    let finishOpening!: () => void;
    vi.mocked(window.operator.invoke).mockImplementation(() => new Promise<void>((resolve) => {
      finishOpening = resolve;
    }));
    const api = makeApi(activeBilling);
    useConnection.setState({ api: api as never });
    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Billing active")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Manage billing/i }));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalled());
    const opening = screen.getByRole("button", { name: /Opening/i }) as HTMLButtonElement;
    expect(opening.disabled).toBe(true);
    fireEvent.click(opening);
    expect(api.post).toHaveBeenCalledTimes(1);
    finishOpening();
    await waitFor(() => expect((screen.getByRole("button", { name: /Manage billing/i }) as HTMLButtonElement).disabled).toBe(false));
  });

  it.each(["request", "redirect", "browser"])("shows a safe retryable error for a %s failure", async (failure) => {
    const api = makeApi(activeBilling);
    if (failure === "request") api.post.mockRejectedValueOnce(new Error("private provider detail"));
    if (failure === "redirect") api.post.mockResolvedValueOnce({ url: "javascript:alert(1)" });
    if (failure === "browser") vi.mocked(window.operator.invoke).mockRejectedValueOnce(new Error("private filesystem path"));
    useConnection.setState({ api: api as never });
    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Billing active")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Manage billing/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Billing portal is unavailable. Try again in a moment."));
    expect((screen.getByRole("button", { name: /Manage billing/i }) as HTMLButtonElement).disabled).toBe(false);
    if (failure !== "browser") expect(window.operator.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Manage billing/i }));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", {
      url: "https://billing.stripe.test/session",
    }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("starts checkout with the selected native billing options", async () => {
    const api = makeApi({
      access: { runtimeProxyAllowed: false, reason: "no_entitlement" },
      entitlement: null,
      trialOffer: { eligible: true, durationDays: 3 },
    });
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
    expect(screen.queryByRole("option", { name: "Annual" })).toBeNull();
    fireEvent.click(screen.getByText(/Server location/));
    expect(screen.getByRole("option", { name: "🇺🇸 Ashburn, Virginia" })).not.toBeNull();
  });

  it("keeps the billing portal available for locked Stripe subscriptions", async () => {
    const api = makeApi({
      access: { runtimeProxyAllowed: false, reason: "payment_required" },
      entitlement: { ...activeBilling.entitlement, status: "past_due" },
      trialOffer: { eligible: false, durationDays: 3 },
    });
    useConnection.setState({ api: api as never });

    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Billing required")).not.toBeNull());

    expect(screen.getByRole("button", { name: /Manage billing/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Continue to checkout/i })).not.toBeNull();
  });
});
