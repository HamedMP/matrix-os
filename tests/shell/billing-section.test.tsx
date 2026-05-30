// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  activePlan: null as string | null,
}));

vi.mock("@clerk/nextjs", () => ({
  PricingTable: (props: {
    for?: string;
    newSubscriptionRedirectUrl?: string;
    checkoutProps?: {
      appearance?: {
        elements?: {
          drawerBackdrop?: { zIndex?: number };
          drawerRoot?: { zIndex?: number };
          drawerContent?: { zIndex?: number };
          modalBackdrop?: { zIndex?: number };
          modalContent?: { zIndex?: number };
        };
      };
    };
  }) => (
    <div
      data-for={props.for}
      data-redirect={props.newSubscriptionRedirectUrl}
      data-drawer-backdrop-z={props.checkoutProps?.appearance?.elements?.drawerBackdrop?.zIndex}
      data-drawer-root-z={props.checkoutProps?.appearance?.elements?.drawerRoot?.zIndex}
      data-drawer-content-z={props.checkoutProps?.appearance?.elements?.drawerContent?.zIndex}
      data-modal-backdrop-z={props.checkoutProps?.appearance?.elements?.modalBackdrop?.zIndex}
      data-modal-content-z={props.checkoutProps?.appearance?.elements?.modalContent?.zIndex}
      data-testid="pricing-table"
    />
  ),
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: true,
    has: ({ plan }: { plan: string }) => plan === clerkState.activePlan,
  }),
}));

describe("BillingSection", () => {
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

  it("surfaces the subscription state and Clerk pricing table", async () => {
    clerkState.isLoaded = true;
    clerkState.activePlan = null;

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

    render(<BillingSection />);

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    expect(screen.getByText("Manage your hosted Matrix computer")).toBeTruthy();
    expect(screen.getByText("Not active")).toBeTruthy();
    expect((await screen.findByTestId("pricing-table")).getAttribute("data-for")).toBe(
      "user",
    );
    expect(screen.getByTestId("pricing-table").getAttribute("data-redirect")).toBe(
      "http://localhost:3000/?checkout=success",
    );
    expect(screen.getByTestId("pricing-table").getAttribute("data-drawer-backdrop-z")).toBe(
      "10000",
    );
    expect(screen.getByTestId("pricing-table").getAttribute("data-drawer-root-z")).toBe(
      "10001",
    );
    expect(screen.getByTestId("pricing-table").getAttribute("data-drawer-content-z")).toBe(
      "10001",
    );
    expect(screen.getByTestId("pricing-table").getAttribute("data-modal-backdrop-z")).toBe(
      "10000",
    );
    expect(screen.getByTestId("pricing-table").getAttribute("data-modal-content-z")).toBe(
      "10001",
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
    expect(screen.getByText("Start trial & provision")).toBeTruthy();
    expect(await screen.findByTestId("pricing-table")).toBeTruthy();
  });

  it.each(["matrix_starter", "matrix_builder", "matrix_max", "early_adopter"])(
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
      screen.getByText("Billing is active for this Clerk account."),
    ).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
    },
  );
});
