// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockBrowserTimeZone } from "../helpers/browser-timezone.js";

/**
 * ENG-520 launch guard: `POST /billing/checkout` answers a free plan owner
 * with 409 `free_upgrade_unavailable` until free to paid upgrade (ENG-606)
 * exists. BillingCheckoutPanel is the one checkout client for Web Desktop, Web
 * Canvas, Electron Desktop, Web Mobile, and the browser step of `matrix login`;
 * Native Mobile never starts checkout. Faults detected: the refusal shown as a
 * generic outage, or the server's error string rendered instead of the fixed copy.
 */

const posthogClientMock = vi.hoisted(() => ({ capturePostHogEvent: vi.fn(), capturePostHogLog: vi.fn() }));
vi.mock("../../shell/src/lib/posthog-client.js", () => posthogClientMock);

async function loadBillingSection() {
  vi.resetModules();
  vi.doMock("@clerk/nextjs", () => ({
    useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_free", has: () => false }),
    useUser: () => ({ user: { publicMetadata: {} } }),
  }));
  const { resetMatrixBillingAccessCacheForTests } = await import("../../shell/src/hooks/useMatrixBillingAccess.js");
  resetMatrixBillingAccessCacheForTests();
  return await import("../../shell/src/components/settings/sections/BillingSection.js");
}

function mockCheckoutResponse(body: unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/billing/checkout") {
      return new Response(JSON.stringify(body), { status: 409, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

async function clickPay() {
  const { BillingSection } = await loadBillingSection();
  const onCheckoutNavigate = vi.fn();
  render(<BillingSection mode="provisioning" onCheckoutNavigate={onCheckoutNavigate} />);
  await waitFor(() => expect(screen.getByTestId("billing-configurator-layout")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Continue to pay" }));
  return onCheckoutNavigate;
}

describe("BillingCheckoutPanel free plan refusal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockBrowserTimeZone("Europe/Berlin");
    window.history.replaceState({}, "", "/");
  });

  it("shows the coming-soon message and does not navigate", async () => {
    mockCheckoutResponse({ code: "free_upgrade_unavailable", error: "Upgrades for free computers are coming soon." });
    const onCheckoutNavigate = await clickPay();
    expect(await screen.findByText("Upgrades for free computers are coming soon.")).toBeTruthy();
    expect(onCheckoutNavigate).not.toHaveBeenCalled();
  });

  it("shows the fixed client copy, never the server's error string", async () => {
    mockCheckoutResponse({ code: "free_upgrade_unavailable", error: "pg: relation user_machines /srv/secret" });
    await clickPay();
    expect(await screen.findByText("Upgrades for free computers are coming soon.")).toBeTruthy();
    expect(screen.queryByText(/user_machines/)).toBeNull();
  });
});
