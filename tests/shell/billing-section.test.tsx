// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  userId: "user_123",
  activePlan: null as string | null,
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: true,
    userId: clerkState.userId,
    has: ({ plan }: { plan: string }) => plan === clerkState.activePlan,
  }),
}));

describe("BillingSection", () => {
  beforeEach(async () => {
    const { resetMatrixBillingAccessCacheForTests } = await import(
      "../../shell/src/hooks/useMatrixBillingAccess.js"
    );
    resetMatrixBillingAccessCacheForTests();
    vi.restoreAllMocks();
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

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

    render(<BillingSection />);

    expect(screen.getByText("Checking")).toBeTruthy();
    expect(screen.getByText("Checking billing status")).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("surfaces the subscription state and checkout action", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

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
    expect(screen.queryByTestId("pricing-table")).toBeNull();
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

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

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

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

    render(<BillingSection />);
    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Builder/ }));
    fireEvent.click(screen.getByRole("button", { name: "Annual" }));
    expect(screen.getByRole("button", { name: "Annual" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/billing/checkout",
        expect.objectContaining({
          body: JSON.stringify({ planSlug: "matrix_builder", interval: "annual" }),
        }),
      ),
    );
  });

  it("uses provisioning copy when billing is shown before the hosted computer exists", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

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

  it.each(["matrix_starter", "matrix_builder", "matrix_max"])(
    "marks billing as active when Clerk grants the %s plan",
    async (plan) => {
    clerkState.isLoaded = true;
    clerkState.activePlan = plan;

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

    render(<BillingSection />);

    expect(screen.getByText("Active")).toBeTruthy();
    expect(
      screen.getByText("Billing is active for this Matrix account."),
    ).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
    },
  );

  it("does not mark billing active for the legacy Clerk early_adopter plan", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = "early_adopter";

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

    render(<BillingSection />);

    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());
  });
});
