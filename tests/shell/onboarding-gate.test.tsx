// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const billingGateRender = vi.hoisted(() => vi.fn());
const bootSequenceRender = vi.hoisted(() => vi.fn());
const onboardingNavigation = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("@/lib/onboarding-navigation", () => ({
  navigateForOnboarding: onboardingNavigation.navigate,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/components/BillingGate", () => ({
  BillingGate: ({
    children,
    platformSessionActive,
  }: {
    children: React.ReactNode;
    platformSessionActive?: boolean;
  }) => {
    billingGateRender(platformSessionActive);
    return <div data-testid="billing-gate">{children}</div>;
  },
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
    });
  });

  it.each(["/?billing=setup", "/?plans=1", "/?checkout=success", "/?checkout=success&billing=success"])(
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
      expect(billingGateRender).toHaveBeenCalledWith(false);
    },
  );

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
