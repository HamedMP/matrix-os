// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  userId: "user_123",
  activePlan: null as string | null,
}));
const navigationState = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  SignIn: () => (
    <div data-testid="sign-in-component">Mock SignIn</div>
  ),
  SignUp: () => (
    <div data-testid="sign-up-component">Mock SignUp</div>
  ),
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    userId: clerkState.userId,
    has: ({ plan }: { plan: string }) => plan === clerkState.activePlan,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: navigationState.replace,
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

describe("BillingGate", () => {
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

  afterEach(() => {
    window.history.replaceState({}, "", "/");
    window.sessionStorage.clear();
    navigationState.replace.mockReset();
    vi.restoreAllMocks();
  });

  it("bypasses billing only for explicit test screenshot runs", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_TEST_BYPASS", "1");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
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

  it.each(["matrix_starter", "matrix_builder", "matrix_max"])(
    "renders Matrix OS when the signed-in user has the %s plan",
    async (plan) => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = plan;
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(screen.getByText("Matrix workspace")).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
    },
  );

  it("does not unlock Matrix OS for the legacy Clerk early_adopter plan", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = "early_adopter";
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    await waitFor(() => expect(screen.getByText("Start checkout & provision")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
  });

  it("keeps the shell visible behind locked billing settings when the user has not subscribed", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Matrix workspace")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(await screen.findByText("Pick the cloud computer Matrix boots on")).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Appearance Locked until billing is active",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("shows confirmation feedback after a completed checkout redirect", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?checkout=success");
    window.sessionStorage.setItem("matrix.billing.checkoutAttemptAt", String(Date.now()));
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
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
    clerkState.activePlan = "matrix_starter";
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

  it("keeps direct checkout success navigation on the checkout panel", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?checkout=success");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByRole("button", { name: "Continue to pay" })).toBeTruthy();
    expect(screen.queryByText("Confirming your subscription")).toBeNull();
  });

  it("records a checkout attempt before opening checkout", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    await screen.findByRole("button", { name: "Continue to pay" });
    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    expect(
      Number(window.sessionStorage.getItem("matrix.billing.checkoutAttemptAt")),
    ).toBeGreaterThan(0);
  });

  it("prompts unauthenticated visitors to sign in before checkout", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.activePlan = null;
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
