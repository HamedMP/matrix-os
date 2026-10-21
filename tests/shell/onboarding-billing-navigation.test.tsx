// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  userId: "new-user",
  getToken: vi.fn(async () => "test-token"),
}));
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => auth,
  RedirectToSignIn: () => <div>Sign in</div>,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/lib/onboarding-navigation", () => ({
  navigateForOnboarding: navigation.replace,
}));
vi.mock("@/lib/posthog-client", () => ({
  capturePostHogEvent: vi.fn(),
  capturePostHogLog: vi.fn(),
}));
// Keep the actual onboarding, billing and journey gates together. Only replace
// leaf presentations; the billing hook and journey hook use the fetch fixture.
vi.mock("@/components/Settings", () => ({
  Settings: ({ lockedSection }: { lockedSection?: string }) => (
    <div data-testid="billing-settings">{lockedSection}</div>
  ),
}));
vi.mock("@/components/runtime/RuntimeManager", () => ({
  AddComputerOnboarding: () => <div>Add computer</div>,
}));
vi.mock("@/components/MatrixLoadingScreen", () => ({
  MatrixLoadingScreen: () => <div data-testid="boot-loading">Loading</div>,
}));

import { OnboardingGate } from "../../shell/src/components/OnboardingGate";
import { resetMatrixBillingAccessCacheForTests } from "../../shell/src/hooks/useMatrixBillingAccess";

const journey = {
  phase: "plan_required",
  detail: "Choose a plan to create your Matrix computer.",
  nextAction: { kind: "open_plans", url: "/?plans=1" },
};

describe("onboarding billing navigation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    window.sessionStorage.clear();
    navigation.replace.mockReset();
    resetMatrixBillingAccessCacheForTests();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/journey")) return Response.json(journey);
      if (url.includes("/billing/status")) {
        return Response.json({ access: { runtimeProxyAllowed: false } });
      }
      throw new Error(`Unexpected test request: ${url}`);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  async function expectStableBilling() {
    expect(await screen.findByTestId("billing-settings")).toBeTruthy();
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) =>
        String(url).startsWith("/api/journey"))).toBe(true);
    });
    await act(async () => {});
    expect(screen.queryByText("View plans")).toBeNull();
    expect(screen.queryByText("Choose your plan")).toBeNull();
  }

  it("redirects a new user once and stays on billing after arrival", async () => {
    const firstPage = render(<OnboardingGate><div>Workspace</div></OnboardingGate>);
    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledExactlyOnceWith("/?plans=1");
    });
    firstPage.unmount();

    window.history.replaceState({}, "", "/?plans=1");
    render(<OnboardingGate><div>Workspace</div></OnboardingGate>);
    await expectStableBilling();
    expect(navigation.replace).toHaveBeenCalledTimes(1);
  });

  it.each([
    "/?plans=1",
    "/?billing=setup",
    "/?checkout=cancelled",
    "/?checkout=success",
    "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
  ])("does not redirect behind billing at %s", async (url) => {
    window.history.replaceState({}, "", url);
    render(<OnboardingGate><div>Workspace</div></OnboardingGate>);
    await expectStableBilling();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
