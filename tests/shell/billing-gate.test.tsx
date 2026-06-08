// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  userId: "user_123",
  activePlan: null as string | null,
  getToken: vi.fn(async () => "clerk-token"),
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
  UserButton: Object.assign(
    ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="clerk-user-button">{children}</div>
    ),
    {
      MenuItems: ({ children }: { children?: React.ReactNode }) => (
        <div data-testid="clerk-user-button-menu">{children}</div>
      ),
      Link: ({ label }: { label: string }) => (
        <a href="/runtime">{label}</a>
      ),
    },
  ),
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    userId: clerkState.userId,
    has: ({ plan }: { plan: string }) => plan === clerkState.activePlan,
    getToken: clerkState.getToken,
  }),
  useUser: () => ({
    user: {
      fullName: null,
      username: "test-user",
      imageUrl: "",
      primaryEmailAddress: { emailAddress: "test@example.com" },
    },
  }),
  useClerk: () => ({
    signOut: vi.fn(async () => undefined),
    openUserProfile: vi.fn(),
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
    clerkState.getToken.mockResolvedValue("clerk-token");
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

  it("renders the shell for server-verified native app sessions without Clerk client auth", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.activePlan = null;
    vi.resetModules();

    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate platformSessionActive>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(screen.getByText("Matrix workspace")).toBeTruthy();
    expect(screen.queryByText("Opening Matrix OS sign in")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("bypasses cached inactive billing status after returning from checkout", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access: { runtimeProxyAllowed: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    await screen.findByRole("button", { name: "Continue to pay" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    cleanup();
    window.history.replaceState({}, "", "/?checkout=success");
    window.sessionStorage.setItem("matrix.billing.checkoutAttemptAt", String(Date.now()));

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Matrix workspace")).toBeTruthy();
    expect(navigationState.replace).toHaveBeenCalledWith("/");
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

  it("provisions and polls with the CLI device return path once billing is active", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState(
      {},
      "",
      "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    );
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    clerkState.getToken.mockResolvedValue("clerk-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/billing/status") {
        return new Response(JSON.stringify({ access: { runtimeProxyAllowed: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (input === "/api/auth/provision-runtime") {
        return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/auth/app-session") {
        return new Response(JSON.stringify({ error: "Matrix computer unavailable" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 503 });
    });
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Confirming your subscription")).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/provision-runtime",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({}),
        }),
      ),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/app-session",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ redirectTo: "/auth/device?user_code=BCDF-GHJK" }),
        }),
      ),
    );
    expect(navigationState.replace).not.toHaveBeenCalled();
  });

  it("surfaces a retry state when CLI device runtime provisioning fails", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState(
      {},
      "",
      "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    );
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    clerkState.getToken.mockResolvedValue("clerk-token");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/billing/status") {
        return new Response(JSON.stringify({ access: { runtimeProxyAllowed: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (input === "/api/auth/provision-runtime") {
        return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 503 });
    });
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Matrix setup needs attention")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Confirming your subscription")).toBeNull();
  });

  it("surfaces a retry state when CLI device billing has not propagated to provisioning", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState(
      {},
      "",
      "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    );
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    clerkState.getToken.mockResolvedValue("clerk-token");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/billing/status") {
        return new Response(JSON.stringify({ access: { runtimeProxyAllowed: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (input === "/api/auth/provision-runtime") {
        return new Response("{}", { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 503 });
    });
    vi.resetModules();

    const { BillingGate } = await import("../../shell/src/components/BillingGate.js");

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Matrix setup needs attention")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Confirming your subscription")).toBeNull();
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
