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

  it("surfaces the early adopter subscription state and Clerk pricing table", async () => {
    clerkState.isLoaded = true;
    clerkState.hasPlan = false;

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

    render(<BillingSection />);

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    expect(screen.getByText("Early adopter access")).toBeTruthy();
    expect(screen.getByText("Not active")).toBeTruthy();
    expect(screen.getByTestId("pricing-table").getAttribute("data-for")).toBe("user");
  });

  it("marks early adopter as active when Clerk grants the plan", async () => {
    clerkState.isLoaded = true;
    clerkState.hasPlan = true;

    const { BillingSection } = await import(
      "../../shell/src/components/settings/sections/BillingSection.js"
    );

    render(<BillingSection />);

    expect(screen.getByText("Active")).toBeTruthy();
    expect(
      screen.getByText("Your early adopter access is active for this Clerk account."),
    ).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });
});
