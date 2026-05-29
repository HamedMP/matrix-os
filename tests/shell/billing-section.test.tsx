// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  hasPlan: false,
}));

vi.mock("@clerk/nextjs", () => ({
  PricingTable: (props: { for?: string; newSubscriptionRedirectUrl?: string }) => (
    <div
      data-for={props.for}
      data-redirect={props.newSubscriptionRedirectUrl}
      data-testid="pricing-table"
    />
  ),
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: true,
    has: ({ plan }: { plan: string }) => plan === "early_adopter" && clerkState.hasPlan,
  }),
}));

describe("BillingSection", () => {
  it("waits for Clerk before rendering a subscription state", async () => {
    clerkState.isLoaded = false;
    clerkState.hasPlan = true;

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
    clerkState.hasPlan = false;

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
  });

  it("uses provisioning copy when billing is shown before the hosted computer exists", async () => {
    clerkState.isLoaded = true;
    clerkState.hasPlan = false;

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

  it("marks billing as active when Clerk grants a paid plan", async () => {
    clerkState.isLoaded = true;
    clerkState.hasPlan = true;

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

    render(<BillingSection />);

    expect(screen.getByText("Active")).toBeTruthy();
    expect(
      screen.getByText("Billing is active for this Clerk account."),
    ).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });
});
