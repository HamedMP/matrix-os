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
  it("surfaces the early adopter subscription state and Clerk pricing table", async () => {
    clerkState.isLoaded = true;
    clerkState.hasPlan = false;

    const { BillingSection } = await import("../../shell/src/components/settings/sections/BillingSection.js");

    render(<BillingSection />);

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    expect(screen.getByText("Early adopter access")).toBeTruthy();
    expect(screen.getByText("Not active")).toBeTruthy();
    expect(screen.getByTestId("pricing-table").getAttribute("data-for")).toBe("user");
  });

  it("marks early adopter as active when Clerk grants the plan", async () => {
    clerkState.isLoaded = true;
    clerkState.hasPlan = true;

    const { BillingSection } = await import("../../shell/src/components/settings/sections/BillingSection.js");

    render(<BillingSection />);

    expect(screen.getByText("Active")).toBeTruthy();
  });
});
