// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  hasPlan: false,
}));
const navigationState = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  PricingTable: (props: { for?: string; newSubscriptionRedirectUrl?: string }) => (
    <div
      data-for={props.for}
      data-redirect={props.newSubscriptionRedirectUrl}
      data-testid="pricing-table"
    >
      <button type="button">Start trial</button>
    </div>
  ),
  SignIn: () => (
    <div data-testid="sign-in-component">Mock SignIn</div>
  ),
  SignUp: () => (
    <div data-testid="sign-up-component">Mock SignUp</div>
  ),
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    has: ({ plan }: { plan: string }) => plan === "early_adopter" && clerkState.hasPlan,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: navigationState.replace,
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

describe("BillingGate", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    window.sessionStorage.clear();
    navigationState.replace.mockReset();
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

  it("renders Matrix OS when the signed-in user has a paid plan", async () => {
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

  it("keeps the shell visible behind locked billing settings when the user has not subscribed", async () => {
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

    expect(screen.getByText("Matrix workspace")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByText("Pick the cloud computer Matrix boots on")).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Appearance Locked until billing is active",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((await screen.findByTestId("pricing-table")).getAttribute("data-for")).toBe(
      "user",
    );
    expect(screen.getByTestId("pricing-table").getAttribute("data-redirect")).toBe(
      "http://localhost:3000/?checkout=success",
    );
  });

  it("shows confirmation feedback after a completed checkout redirect", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?checkout=success");
    window.sessionStorage.setItem("matrix.billing.checkoutAttemptAt", String(Date.now()));
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
    expect(screen.getByText("Matrix workspace")).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("cleans the checkout success query once the plan is active", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?checkout=success");
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

    expect(await screen.findByText("Matrix workspace")).toBeTruthy();
    expect(navigationState.replace).toHaveBeenCalledWith("/");
  });

  it("keeps direct checkout success navigation on the pricing table", async () => {
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

    expect(await screen.findByTestId("pricing-table")).toBeTruthy();
    expect(screen.queryByText("Confirming your subscription")).toBeNull();
  });

  it("records a checkout attempt before interacting with the pricing table", async () => {
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

    await screen.findByTestId("pricing-table");
    fireEvent.click(screen.getByRole("button", { name: /start trial/i }));

    expect(
      Number(window.sessionStorage.getItem("matrix.billing.checkoutAttemptAt")),
    ).toBeGreaterThan(0);
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
    expect(screen.getByText("Opening Matrix OS sign in")).toBeTruthy();
    expect(screen.queryByTestId("sign-in-component")).toBeNull();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });
});
