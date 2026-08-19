// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  userId: "user_123" as string | null,
  activePlan: null as string | null,
}));

function installClerkMock() {
  vi.doMock("@clerk/nextjs", () => ({
    useAuth: () => ({
      isLoaded: clerkState.isLoaded,
      isSignedIn: clerkState.isSignedIn,
      userId: clerkState.userId,
      has: ({ plan }: { plan: string }) => plan === clerkState.activePlan,
    }),
    useUser: () => ({ user: { publicMetadata: {} } }),
  }));
}

async function loadBillingSection() {
  vi.resetModules();
  installClerkMock();
  return await import("../../shell/src/components/settings/sections/BillingSection.js");
}

describe("BillingSection", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    installClerkMock();
    const { resetMatrixBillingAccessCacheForTests } = await import(
      "../../shell/src/hooks/useMatrixBillingAccess.js"
    );
    resetMatrixBillingAccessCacheForTests();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.userId = "user_123";
    clerkState.activePlan = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for Clerk before rendering a subscription state", async () => {
    clerkState.isLoaded = false;
    clerkState.activePlan = "matrix_starter";

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    expect(screen.getByText("Checking")).toBeTruthy();
    expect(screen.getByText("Checking billing status")).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("surfaces the subscription state and checkout action", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
    expect(screen.getByText("Manage your hosted Matrix computer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
    expect(screen.getByText("Secure checkout")).toBeTruthy();
    expect(screen.getByText("Visa")).toBeTruthy();
    expect(screen.getByText("Mastercard")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Monthly" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Annual" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("Developer tools")).toBeNull();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("explains the card-required seven-day trial before opening Checkout", async () => {
    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const formattedTrialEnd = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(trialEnd);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access: { runtimeProxyAllowed: false },
        trialOffer: { eligible: true, durationDays: 7 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="provisioning" />);

    await waitFor(() => expect(screen.getByText("Start your 7-day free trial")).toBeTruthy());
    expect(screen.getByText("Card required")).toBeTruthy();
    expect(screen.getByText("$0 today").classList.contains("text-cream")).toBe(true);
    expect(screen.getByText(`First charge ${formattedTrialEnd}`)).toBeTruthy();
    expect(screen.getByText(`Cancel before ${formattedTrialEnd} to avoid being charged.`)).toBeTruthy();
    expect(screen.getByText("$19/month after your trial")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start 7-day trial" })).toBeTruthy();
  });

  it("keeps immediate-payment language for additional computers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access: { runtimeProxyAllowed: false },
        trialOffer: { eligible: true, durationDays: 7 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="add-computer" checkoutRuntimeSlot="studio" />);

    await waitFor(() => expect(screen.getByText("New subscription")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
    expect(screen.queryByText("Start your 7-day free trial")).toBeNull();
  });

  it("shows the authoritative end date and upcoming charge for an active trial", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access: { runtimeProxyAllowed: true, reason: "active" },
        trialOffer: { eligible: false, durationDays: 7 },
        entitlement: {
          source: "stripe",
          planSlug: "matrix_builder",
          status: "trialing",
          maxRuntimeSlots: 1,
          includedRuntimeSlots: 1,
          addonRuntimeSlots: 0,
          defaultServerType: "cpx32",
          allowedServerTypes: ["cpx22", "cpx32"],
          stripeSubscriptionId: "sub_trial",
          stripePriceId: "price_builder_monthly",
          billingInterval: "monthly",
          gracePeriodEndsAt: null,
          trialStartedAt: "2026-08-19T00:00:00.000Z",
          trialEndsAt: "2026-08-26T00:00:00.000Z",
          trialConvertedAt: null,
          firstTrialPaymentFailedAt: null,
          effectiveFrom: "2026-08-19T00:00:00.000Z",
          effectiveUntil: null,
          updatedAt: "2026-08-19T00:00:00.000Z",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(screen.getByText("Free trial active")).toBeTruthy());
    expect(screen.getByText("Your first $19 monthly charge is on Aug 26, 2026.")).toBeTruthy();
    expect(screen.getByText("Cancel before Aug 26, 2026 to avoid being charged.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage trial" })).toBeTruthy();
  });

  it("routes a failed trial conversion to payment recovery instead of a new checkout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access: { runtimeProxyAllowed: false, reason: "payment_required" },
        trialOffer: { eligible: false, durationDays: 7 },
        entitlement: {
          source: "stripe", planSlug: "matrix_builder", status: "past_due",
          maxRuntimeSlots: 1, includedRuntimeSlots: 1, addonRuntimeSlots: 0,
          defaultServerType: "cpx32", allowedServerTypes: ["cpx22", "cpx32"],
          stripeSubscriptionId: "sub_trial", stripePriceId: "price_builder_monthly",
          billingInterval: "monthly", gracePeriodEndsAt: null,
          trialStartedAt: "2026-08-19T00:00:00.000Z", trialEndsAt: "2026-08-26T00:00:00.000Z",
          trialConvertedAt: null, firstTrialPaymentFailedAt: "2026-08-26T00:00:00.000Z",
          effectiveFrom: "2026-08-19T00:00:00.000Z", effectiveUntil: null,
          updatedAt: "2026-08-26T00:00:00.000Z",
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(screen.getByText("Payment required")).toBeTruthy());
    expect(screen.getByText("Runtime access is paused until the first payment succeeds.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update payment method" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue to pay" })).toBeNull();
  });

  it("shows a reconnecting billing session state when signed-out app-session billing returns 401", async () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.userId = null;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 401,
        headers: { "content-type": "application/json", "x-auth-failure": "app-session-stale" },
      }),
    );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/billing/status",
      expect.objectContaining({
        credentials: "include",
        method: "GET",
      }),
    ));
    await waitFor(() => expect(screen.getByText("Reconnecting")).toBeTruthy());
    expect(screen.getByText("Reconnecting billing session")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue to pay" })).toBeNull();
  });

  it("does not cache signed-out billing 401 and unlocks after session refresh succeeds", async () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.userId = null;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", "x-auth-failure": "app-session-stale" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access: { runtimeProxyAllowed: true, reason: "active" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Reconnecting billing session")).toBeTruthy());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    await waitFor(() => expect(screen.getAllByText("Active").length).toBeGreaterThanOrEqual(1));
  });

  it("shows payment setup instead of reconnecting for a plain signed-out billing 401", async () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.userId = null;
    clerkState.activePlan = null;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
    expect(screen.queryByText("Reconnecting billing session")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
  });

  it("keeps billing status unknown and retries after transient status failures", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Checking billing status")).toBeTruthy();
    expect(screen.queryByText("Not active")).toBeNull();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
  });

  it("lets users choose annual billing before checkout", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Change computer" }));
    fireEvent.click(screen.getByRole("button", { name: /Builder/ }));
    fireEvent.click(screen.getByRole("button", { name: "Change region" }));
    fireEvent.click(screen.getByRole("button", { name: /Nuremberg, Germany/ }));
    fireEvent.click(screen.getByRole("button", { name: "Annual" }));
    expect(screen.getByRole("button", { name: "Annual" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/billing/checkout",
        expect.objectContaining({
          body: JSON.stringify({
            planSlug: "matrix_builder",
            interval: "annual",
            regionSlug: "region_nbg1",
          }),
        }),
      ),
    );
  });

  it("closes only the picker on Escape without dismissing the Settings panel", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Change computer" }));
    expect(screen.getByRole("button", { name: /Builder/ })).toBeTruthy();

    // The Settings panel registers a window-level Escape handler; it must not
    // receive the event once the picker has handled and stopped it.
    const settingsEscape = vi.fn();
    window.addEventListener("keydown", settingsEscape);
    try {
      fireEvent.keyDown(document, { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", settingsEscape);
    }

    expect(screen.queryByRole("button", { name: /Builder/ })).toBeNull();
    expect(settingsEscape).not.toHaveBeenCalled();
  });

  it("includes a safe return path when checkout is launched from CLI device setup", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { BillingSection } = await loadBillingSection();

    render(
      <BillingSection
        mode="provisioning"
        checkoutReturnPath="/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK"
      />,
    );
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/billing/checkout",
        expect.objectContaining({
          body: JSON.stringify({
            planSlug: "matrix_builder",
            interval: "monthly",
            regionSlug: "region_fsn1",
            returnPath: "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
          }),
        }),
      ),
    );
  });

  it("explains how to resume a checkout with different selections", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/billing/checkout") {
        return new Response(JSON.stringify({
          error: "Checkout selection conflicts with an open session",
          code: "checkout_selection_conflict",
          selection: {
            planSlug: "matrix_starter",
            interval: "annual",
            regionSlug: "region_nbg1",
          },
        }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="provisioning" />);
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    expect(
      await screen.findByText(
        "A Starter annual checkout in Nuremberg, Germany is already open. Select those choices to continue it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Checkout is unavailable. Try again in a moment.")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/billing/checkout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses provisioning copy when billing is shown before the hosted computer exists", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="provisioning" />);

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
    expect(screen.getByText("Pick the cloud computer Matrix boots on")).toBeTruthy();
    expect(screen.getAllByText("Computer").length).toBeGreaterThanOrEqual(1);

    // Computer options live in a click-to-open dropdown now.
    fireEvent.click(screen.getByRole("button", { name: "Change computer" }));
    expect(screen.getByText("CPX22")).toBeTruthy();
    expect(screen.getByText("$14")).toBeTruthy();
    expect(screen.getAllByText("CPX32").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$19").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("CPX52")).toBeTruthy();
    expect(screen.getByText("$49")).toBeTruthy();

    // Region options live in their own dropdown (opening it closes the computer one).
    fireEvent.click(screen.getByRole("button", { name: "Change region" }));
    expect(screen.getAllByText("Region").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Closest location is selected automatically")).toBeTruthy();
    expect(screen.getAllByText("🇩🇪").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("🇺🇸").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("ash")).toBeTruthy();
    expect(screen.queryByText("sin")).toBeNull();
    expect(screen.getByText("Start checkout & provision")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("uses device setup copy when billing is opened from CLI login", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await loadBillingSection();

    render(
      <BillingSection
        mode="device-setup"
        checkoutReturnPath="/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK"
      />,
    );

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
    expect(
      screen.getByText("Choose billing in Settings, then Matrix returns to CLI device approval."),
    ).toBeTruthy();
    expect(screen.getByText("Finish billing to approve CLI login")).toBeTruthy();
    expect(screen.getByText("Billing settings")).toBeTruthy();
    expect(
      screen.getByText("Review your plan and region here. Stripe opens only after you choose Continue to pay."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
  });

  it.each(["matrix_starter", "matrix_builder", "matrix_max"])(
    "marks billing as active when Clerk grants the %s plan",
    async (plan) => {
    clerkState.isLoaded = true;
    clerkState.activePlan = plan;

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    expect(screen.getAllByText("Active").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Current plan")).toBeTruthy();
    expect(screen.getAllByText("Legacy plan").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("pricing-table")).toBeNull();
    },
  );

  it("shows current Stripe plan details and portal actions when billing is active", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          access: { runtimeProxyAllowed: true, reason: "active" },
          entitlement: {
            source: "stripe",
            planSlug: "matrix_builder",
            status: "active",
            maxRuntimeSlots: 3,
            includedRuntimeSlots: 2,
            addonRuntimeSlots: 1,
            defaultServerType: "cpx32",
            allowedServerTypes: ["cpx22", "cpx32"],
            stripeSubscriptionId: "sub_123",
            stripePriceId: "price_123",
            gracePeriodEndsAt: "2026-06-02T00:00:00.000Z",
            effectiveFrom: "2026-05-30T00:00:00.000Z",
            effectiveUntil: null,
            updatedAt: "2026-05-30T00:00:00.000Z",
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ url: "https://billing.stripe.test/session" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(screen.getAllByText("Builder").length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText("Current plan")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("2 included, 1 add-on")).toBeTruthy();
    expect(screen.getByText(/CPX32/)).toBeTruthy();
    expect(screen.getByText("Receipts and payment")).toBeTruthy();
    expect(screen.getByText("Canceling")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View receipts" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/billing/portal",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("does not mark billing active for the legacy Clerk early_adopter plan", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = "early_adopter";

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
  });
});
