// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
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
  SignInButton: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sign-in-button">{children}</div>
  ),
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    has: ({ plan }: { plan: string }) => plan === "early_adopter" && clerkState.hasPlan,
  }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

describe("BillingGate", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("bypasses billing only for explicit test screenshot runs", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_TEST_BYPASS", "1");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.hasPlan = false;
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(screen.getByText("Matrix workspace")).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("renders Matrix OS when the signed-in user has the early adopter plan", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.hasPlan = true;
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(screen.getByText("Matrix workspace")).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("shows Clerk checkout when the user has not subscribed to early adopter", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.hasPlan = false;
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(screen.queryByText("Matrix workspace")).toBeNull();
    expect(screen.getByText("Choose the early adopter plan to continue")).toBeTruthy();
    expect(screen.getByTestId("pricing-table").getAttribute("data-for")).toBe("user");
    expect(screen.getByTestId("pricing-table").getAttribute("data-redirect")).toBe(
      "http://localhost:3000/?checkout=success",
    );
  });

  it("shows confirmation feedback after a completed checkout redirect", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?checkout=success");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.hasPlan = false;
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Confirming your subscription")).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("prompts unauthenticated visitors to sign in before checkout", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.hasPlan = false;
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(screen.queryByText("Matrix workspace")).toBeNull();
    expect(screen.getByText("Sign in to continue")).toBeTruthy();
    expect(screen.getByTestId("sign-in-button")).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });
});
