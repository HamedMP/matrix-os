// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const billingGateRender = vi.hoisted(() => vi.fn());
const bootSequenceRender = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({ suspend: false }));
const suspendedSearchParams = new Promise<never>(() => {});

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
  }: {
    children: React.ReactNode;
    platformSessionActive?: boolean;
    e2eBypass?: boolean;
  }) => {
    bootSequenceRender({ platformSessionActive, e2eBypass });
    return <div data-testid="boot-sequence">{children}</div>;
  },
}));

import { OnboardingGate } from "../../shell/src/components/OnboardingGate";

describe("OnboardingGate", () => {
  beforeEach(() => {
    billingGateRender.mockClear();
    bootSequenceRender.mockClear();
    navigationState.suspend = false;
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
      expect(screen.queryByTestId("boot-sequence")).toBeNull();
      expect(billingGateRender).toHaveBeenCalledWith({
        platformSessionActive: false,
        loadingSurface: "default",
      });
    },
  );

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

  it("keeps device approval billing on BillingGate", async () => {
    window.history.replaceState({}, "", "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK");

    render(
      <OnboardingGate platformSessionActive>
        <div>Matrix workspace</div>
      </OnboardingGate>,
    );

    expect(await screen.findByTestId("billing-gate")).toBeTruthy();
    expect(screen.queryByTestId("boot-sequence")).toBeNull();
    expect(billingGateRender).toHaveBeenCalledWith({
      platformSessionActive: true,
      loadingSurface: "default",
    });
  });
});
