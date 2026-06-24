// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("checks cookie-backed billing status when Clerk is signed out", async () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.userId = null;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 401,
        headers: { "content-type": "application/json" },
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
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
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

    fireEvent.click(screen.getByRole("button", { name: /Builder/ }));
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

  it("uses provisioning copy when billing is shown before the hosted computer exists", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await loadBillingSection();

    render(<BillingSection mode="provisioning" />);

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
    expect(screen.getByText("Pick the cloud computer Matrix boots on")).toBeTruthy();
    expect(screen.getAllByText("Computer").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("CPX22")).toBeTruthy();
    expect(screen.getByText("$14")).toBeTruthy();
    expect(screen.getAllByText("CPX32").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$19").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("CPX52")).toBeTruthy();
    expect(screen.getByText("$49")).toBeTruthy();
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
