// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const billingState = vi.hoisted(() => ({
  active: true as boolean | null,
  checking: false,
  trialOffer: { eligible: false, durationDays: 7 },
  accessReason: "active" as string | null,
  accessIssue: null,
  entitlement: {
    source: "stripe" as const,
    planSlug: "matrix_builder" as const,
    status: "trialing",
    maxRuntimeSlots: 1,
    includedRuntimeSlots: 1,
    addonRuntimeSlots: 0,
    defaultServerType: "cpx32",
    allowedServerTypes: ["cpx22", "cpx32"],
    stripeSubscriptionId: "sub_trial",
    stripePriceId: "price_builder_monthly",
    billingInterval: "monthly" as const,
    gracePeriodEndsAt: null,
    trialStartedAt: "2026-08-19T00:00:00.000Z",
    trialEndsAt: "2026-08-24T00:00:00.000Z",
    trialConvertedAt: null,
    firstTrialPaymentFailedAt: null,
    effectiveFrom: "2026-08-19T00:00:00.000Z",
    effectiveUntil: null,
    updatedAt: "2026-08-19T00:00:00.000Z",
  },
}));

vi.mock("@/hooks/useMatrixBillingAccess", () => ({
  useMatrixBillingAccess: () => billingState,
}));

import { BillingTrialNotification } from "../../shell/src/components/BillingTrialNotification.js";

describe("BillingTrialNotification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00.000Z"));
    billingState.entitlement.trialEndsAt = "2026-08-24T00:00:00.000Z";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("persistently shows days remaining, upcoming price, date, and portal action", () => {
    render(<BillingTrialNotification />);

    expect(screen.getByRole("status", { name: "Matrix free trial" })).toBeTruthy();
    expect(screen.getByText("5 days left in your free trial")).toBeTruthy();
    expect(screen.getByText("$19/month starts Aug 24, 2026.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage trial" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  it("increases prominence during the final three days and opens Stripe portal", async () => {
    billingState.entitlement.trialEndsAt = "2026-08-22T00:00:00.000Z";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const navigate = vi.fn();

    render(<BillingTrialNotification onPortalNavigate={navigate} />);

    const notification = screen.getByRole("status", { name: "Matrix free trial" });
    expect(notification.getAttribute("data-urgent")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Manage trial" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/billing/portal",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(navigate).toHaveBeenCalledWith("https://billing.stripe.com/p/session_123");
  });

  it("rejects non-HTTPS portal URLs without navigating", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: "javascript:alert(1)" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const navigate = vi.fn();
    render(<BillingTrialNotification onPortalNavigate={navigate} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Manage trial" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("Billing portal is unavailable. Try again.")).toBeTruthy();
  });
});
