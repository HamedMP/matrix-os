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
const addComputerRender = vi.hoisted(() => vi.fn());

vi.mock("@/components/runtime/RuntimeManager", () => ({
  AddComputerOnboarding: () => {
    addComputerRender();
    return <div data-testid="add-computer-onboarding">Shared add-computer onboarding</div>;
  },
}));

function installClerkMock() {
  vi.doMock("@clerk/nextjs", () => ({
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
      isLoaded: clerkState.isLoaded,
      isSignedIn: clerkState.isSignedIn,
      user: clerkState.isSignedIn
        ? {
            id: clerkState.userId,
            fullName: null,
            username: "test-user",
            imageUrl: "",
            primaryEmailAddress: { emailAddress: "test@example.com" },
          }
        : null,
    }),
    useClerk: () => ({
      signOut: vi.fn(async () => undefined),
      openUserProfile: vi.fn(),
    }),
  }));
}

async function loadBillingGate() {
  vi.resetModules();
  installClerkMock();
  return await import("../../shell/src/components/BillingGate.js");
}

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({
    replace: navigationState.replace,
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

describe("BillingGate", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    installClerkMock();
    const { resetMatrixBillingAccessCacheForTests } = await import(
      "../../shell/src/hooks/useMatrixBillingAccess.js"
    );
    resetMatrixBillingAccessCacheForTests();
    clerkState.getToken.mockResolvedValue("clerk-token");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
    window.sessionStorage.clear();
    navigationState.replace.mockReset();
    addComputerRender.mockReset();
    vi.restoreAllMocks();
  });

  it("renders the shell for server-verified native app sessions without Clerk client auth", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.activePlan = null;
    vi.resetModules();

    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate platformSessionActive>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(screen.getByText("Matrix workspace")).toBeTruthy();
    expect(screen.queryByText("Opening Matrix OS sign in")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an active subscriber in shared onboarding for an add-computer billing handoff", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?billing=setup&handoff=add-computer");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access: { runtimeProxyAllowed: true, reason: "active" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate platformSessionActive>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByTestId("add-computer-onboarding")).toBeTruthy();
    expect(screen.queryByText("Matrix workspace")).toBeNull();
    expect(addComputerRender).toHaveBeenCalledTimes(1);
  });

  it("keeps the full signup handoff visible while marked billing status resolves", async () => {
    window.history.replaceState({}, "", "/?billing=setup&handoff=signup");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();
    const { container } = render(
      <BillingGate loadingSurface="signup-handoff">
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(container.querySelector('[data-matrix-signup-billing-handoff="true"]')).toBeTruthy();
    expect(screen.getByText("Loading billing status")).toBeTruthy();
    expect(screen.queryByText("Confirming your subscription")).toBeNull();
    expect(screen.queryByText("Welcome back to Matrix")).toBeNull();
  });

  it("opens locked Billing settings directly after the marked handoff resolves inactive", async () => {
    window.history.replaceState({}, "", "/?billing=setup&handoff=signup");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();
    render(
      <BillingGate loadingSurface="signup-handoff">
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByRole("heading", { name: "Billing" })).toBeTruthy();
    expect(screen.queryByText("Loading billing status")).toBeNull();
    expect(screen.queryByText("Confirming your subscription")).toBeNull();
  });

  it("renders the shell for app-session billing access without Clerk client auth", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access: { runtimeProxyAllowed: true, reason: "active" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Matrix workspace")).toBeTruthy();
    expect(screen.queryByText("Opening Matrix OS sign in")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/billing/status",
      expect.objectContaining({
        credentials: "include",
        method: "GET",
      }),
    );
  });

  it("revalidates app-session billing instead of reusing a signed-out active cache", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access: { runtimeProxyAllowed: true, reason: "active" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", "x-auth-failure": "app-session-stale" },
        }),
      );
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Matrix workspace")).toBeTruthy();
    cleanup();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Loading billing status")).toBeTruthy();
    expect(screen.queryByText("Opening Matrix OS sign in")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue to pay" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps signed-out app-session billing in checking state on 401 and unlocks after refresh", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.activePlan = null;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", "x-auth-failure": "app-session-stale" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access: { runtimeProxyAllowed: true, reason: "active" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Loading billing status")).toBeTruthy();
    expect(screen.queryByText("Opening Matrix OS sign in")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue to pay" })).toBeNull();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(await screen.findByText("Matrix workspace")).toBeTruthy();
  });

  it("redirects signed-out users instead of reconnecting on a plain billing 401", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;
    clerkState.activePlan = null;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Opening Matrix OS sign in")).toBeTruthy();
    expect(screen.queryByText("Loading billing status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue to pay" })).toBeNull();
  });

  it("bypasses billing only for explicit test screenshot runs", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_TEST_BYPASS", "1");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

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

    const { BillingGate } = await loadBillingGate();

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

    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    await waitFor(() => expect(screen.getByText("Choose your Matrix computer")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
  });

  it("keeps the shell visible behind locked billing settings when the user has not subscribed", async () => {
    vi.unstubAllEnvs();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Matrix workspace")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(await screen.findByText("Choose your Matrix computer")).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Appearance Locked until billing is active",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });

  it("sends the allowlisted device approval path when device login starts checkout", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.resetModules();

    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Matrix workspace")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy();
    expect(await screen.findByText("Finish billing")).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Choose your Matrix computer" }),
    ).toBeTruthy();
    expect(screen.queryByText("Billing settings")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue to pay" })).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/billing/checkout")),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/billing/checkout",
        expect.objectContaining({
          body: JSON.stringify({
            planSlug: "matrix_builder",
            interval: "monthly",
            regionSlug: "region_fsn1",
            serverType: "cpx42",
            developerTools: ["codex", "claude-code", "opencode", "pi"],
            returnPath: "/auth/device?user_code=BCDF-GHJK",
          }),
        }),
      ),
    );
  });

  it("shows confirmation feedback after a completed checkout redirect", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?checkout=success");
    window.sessionStorage.setItem("matrix.billing.checkoutAttemptAt", String(Date.now()));
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

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

    const { BillingGate } = await loadBillingGate();

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
    expect(navigationState.replace).not.toHaveBeenCalled();
  });

  it("leaves checkout continuation routing to the journey once the plan is active", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?checkout=success");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = "matrix_starter";
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Matrix workspace")).toBeTruthy();
    expect(navigationState.replace).not.toHaveBeenCalled();
  });

  it("hands a paid CLI device return to its journey child without provisioning again", async () => {
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
      return new Response("", { status: 503 });
    });
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(await screen.findByText("Matrix workspace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Default installs" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Build VPS" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/auth/provision-runtime")).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/auth/app-session")).toBe(false);
  });

  it("keeps direct checkout success navigation on the checkout panel", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?checkout=success");
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.activePlan = null;
    vi.resetModules();

    const { BillingGate } = await loadBillingGate();

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

    const { BillingGate } = await loadBillingGate();

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

    const { BillingGate } = await loadBillingGate();

    render(
      <BillingGate>
        <div>Matrix workspace</div>
      </BillingGate>,
    );

    expect(screen.queryByText("Matrix workspace")).toBeNull();
    expect(await screen.findByText("Opening Matrix OS sign in")).toBeTruthy();
    expect(screen.queryByTestId("sign-in-component")).toBeNull();
    expect(screen.queryByTestId("pricing-table")).toBeNull();
  });
});
