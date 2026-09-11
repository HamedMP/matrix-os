// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const billingGateRender = vi.hoisted(() => vi.fn());
const bootSequenceRender = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({ suspend: false }));
const suspendedSearchParams = new Promise<never>(() => {});
const onboardingNavigation = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("@/lib/onboarding-navigation", () => ({
  navigateForOnboarding: onboardingNavigation.navigate,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => {
    if (navigationState.suspend) throw suspendedSearchParams;
    return new URLSearchParams(window.location.search);
  },
}));

vi.mock("@/components/BillingGate", () => ({
  BillingGate: ({
    children,
    platformSessionActive,
    loadingSurface,
  }: {
    children: React.ReactNode;
    platformSessionActive?: boolean;
    loadingSurface?: "default" | "signup-handoff";
  }) => {
    billingGateRender({ platformSessionActive, loadingSurface });
    return <div data-testid="billing-gate">{children}</div>;
  },
}));

vi.mock("@/components/auth/SignupBillingHandoff", () => ({
  SignupBillingHandoff: () => (
    <div data-testid="signup-billing-handoff">Loading billing status</div>
  ),
}));

vi.mock("@/components/BootSequence", () => ({
  BootSequence: ({
    children,
    platformSessionActive,
    e2eBypass,
    completionRedirect,
    runtimeSlot,
    passivePostCheckout,
  }: {
    children: React.ReactNode;
    platformSessionActive?: boolean;
    e2eBypass?: boolean;
    completionRedirect?: string;
    runtimeSlot?: string | null;
    passivePostCheckout?: boolean;
  }) => {
    bootSequenceRender({
      platformSessionActive,
      e2eBypass,
      completionRedirect,
      runtimeSlot,
      passivePostCheckout,
    });
    return <div data-testid="boot-sequence">{children}</div>;
  },
}));

import { OnboardingGate } from "../../shell/src/components/OnboardingGate";

describe("OnboardingGate", () => {
  beforeEach(() => {
    billingGateRender.mockClear();
    bootSequenceRender.mockClear();
    navigationState.suspend = false;
    onboardingNavigation.navigate.mockClear();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the journey boot sequence for normal shell entry", async () => {
    render(
      <OnboardingGate>
        <div>Matrix workspace</div>
      </OnboardingGate>,
    );

    expect(await screen.findByTestId("boot-sequence")).toBeTruthy();
    expect(screen.queryByTestId("billing-gate")).toBeNull();
    expect(bootSequenceRender).toHaveBeenCalledWith({
      platformSessionActive: false,
      e2eBypass: false,
      completionRedirect: undefined,
      runtimeSlot: undefined,
      passivePostCheckout: undefined,
    });
  });

  it.each([
    "/?billing=setup",
    "/?billing=setup&handoff=add-computer",
    "/?plans=1",
    "/?checkout=success",
    "/?checkout=success&billing=success",
  ])(
    "keeps explicit billing entrypoint %s on BillingGate",
    async (path) => {
      window.history.replaceState({}, "", path);

      render(
        <OnboardingGate>
          <div>Matrix workspace</div>
        </OnboardingGate>,
      );

      expect(await screen.findByTestId("billing-gate")).toBeTruthy();
      expect(screen.getByTestId("boot-sequence")).toBeTruthy();
      expect(billingGateRender).toHaveBeenCalledWith({
        platformSessionActive: false,
        loadingSurface: "default",
      });
    },
  );

  it("continues a paid device return through passive journey polling without another build decision", async () => {
    window.history.replaceState(
      {},
      "",
      "/?checkout=success&runtime=studio&device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    );

    render(
      <OnboardingGate>
        <div>Matrix workspace</div>
      </OnboardingGate>,
    );

    expect(await screen.findByTestId("billing-gate")).toBeTruthy();
    expect(screen.getByTestId("boot-sequence")).toBeTruthy();
    expect(bootSequenceRender).toHaveBeenCalledWith({
      platformSessionActive: false,
      e2eBypass: false,
      completionRedirect:
        "/?runtime=studio&device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
      runtimeSlot: "studio",
      passivePostCheckout: true,
    });
  });

  it("drops an invalid runtime selector before device journey and session polling", async () => {
    window.history.replaceState(
      {},
      "",
      "/?checkout=success&runtime=Bad%20Slot!&device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    );

    render(
      <OnboardingGate>
        <div>Matrix workspace</div>
      </OnboardingGate>,
    );

    expect(await screen.findByTestId("boot-sequence")).toBeTruthy();
    expect(bootSequenceRender).toHaveBeenCalledWith(expect.objectContaining({
      completionRedirect: "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
      runtimeSlot: null,
      passivePostCheckout: true,
    }));
  });

  it("selects the signup surface only for the exact marker", async () => {
    for (const path of [
      "/?billing=setup&handoff=signup",
      "/?handoff=signup&billing=setup",
    ]) {
      window.history.replaceState({}, "", path);
      const view = render(
        <OnboardingGate>
          <div>Matrix workspace</div>
        </OnboardingGate>,
      );

      expect(await screen.findByTestId("billing-gate")).toBeTruthy();
      expect(billingGateRender).toHaveBeenLastCalledWith({
        platformSessionActive: false,
        loadingSurface: "signup-handoff",
      });
      view.unmount();
    }

    for (const path of [
      "/?billing=setup&handoff=signup-extra",
      "/?billing=setup&handoff=signup&handoff=signup",
      "/?billing=other&handoff=signup",
      "/other?billing=setup&handoff=signup",
    ]) {
      billingGateRender.mockClear();
      window.history.replaceState({}, "", path);
      const view = render(
        <OnboardingGate>
          <div>Matrix workspace</div>
        </OnboardingGate>,
      );

      expect(await screen.findByTestId("billing-gate")).toBeTruthy();
      expect(billingGateRender).not.toHaveBeenCalledWith(
        expect.objectContaining({ loadingSurface: "signup-handoff" }),
      );
      view.unmount();
    }
  });

  it("uses the signup handoff as the outer Suspense fallback", () => {
    navigationState.suspend = true;

    render(
      <OnboardingGate initialLoadingSurface="signup-handoff">
        <div>Matrix workspace</div>
      </OnboardingGate>,
    );

    expect(screen.getByTestId("signup-billing-handoff")).toBeTruthy();
    expect(screen.queryByText("Loading your Matrix computer…")).toBeNull();
  });

  it("returns a server-verified device flow to approval after the boot page reaches the shell", async () => {
    window.history.replaceState({}, "", "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK");

    render(
      <OnboardingGate platformSessionActive>
        <div>Matrix workspace</div>
      </OnboardingGate>,
    );

    await vi.waitFor(() => {
      expect(onboardingNavigation.navigate).toHaveBeenCalledWith(
        "/auth/device?user_code=BCDF-GHJK",
      );
    });
    expect(screen.queryByTestId("billing-gate")).toBeNull();
    expect(screen.queryByTestId("boot-sequence")).toBeNull();
    expect(billingGateRender).not.toHaveBeenCalled();
  });
});
