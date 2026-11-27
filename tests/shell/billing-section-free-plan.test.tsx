// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shell/src/lib/posthog-client.js", () => ({ capturePostHogEvent: vi.fn(), capturePostHogLog: vi.fn() }));

async function loadBillingSection() {
  vi.resetModules();
  vi.doMock("@clerk/nextjs", () => ({
    useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_123", has: () => false }),
    useUser: () => ({ user: { publicMetadata: {} } }),
  }));
  const { resetMatrixBillingAccessCacheForTests } = await import("../../shell/src/hooks/useMatrixBillingAccess.js");
  resetMatrixBillingAccessCacheForTests();
  return await import("../../shell/src/components/settings/sections/BillingSection.js");
}

describe("Settings > Billing on the Free plan", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("describes the Free plan to a free owner instead of a paid subscription (ENG-520)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access: { runtimeProxyAllowed: true, reason: "active" },
        trialOffer: { eligible: false, durationDays: 3 },
        entitlement: {
          source: "free",
          planSlug: "matrix_free",
          status: "active",
          maxRuntimeSlots: 1,
          includedRuntimeSlots: 1,
          addonRuntimeSlots: 0,
          allowedPlanSlugs: [],
          allowedSelections: [],
          portalAvailable: false,
          billingInterval: null,
          gracePeriodEndsAt: null,
          trialStartedAt: null,
          trialEndsAt: null,
          trialConvertedAt: null,
          firstTrialPaymentFailedAt: null,
          effectiveFrom: "2026-11-20T00:00:00.000Z",
          effectiveUntil: null,
          updatedAt: "2026-11-20T00:00:00.000Z",
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { FREE_PLAN_COPY, MATRIX_PRICING_URL } = await import("../../packages/contracts/src/free-plan-copy.js");
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    expect(await screen.findByRole("heading", { name: "Free" })).toBeTruthy();
    expect(screen.getByText(FREE_PLAN_COPY.summary)).toBeTruthy();
    expect(screen.getByText(FREE_PLAN_COPY.sleep)).toBeTruthy();
    expect(screen.getByText(FREE_PLAN_COPY.upgrade)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See paid plans" }).getAttribute("href")).toBe(MATRIX_PRICING_URL);
    for (const paidOnly of [/matrix_free/, /Managed subscription/, /Canceling/, /billing portal/i, /if you have paid/]) {
      expect(screen.queryByText(paidOnly)).toBeNull();
    }
  });
});
