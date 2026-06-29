// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function installClerkMock(selectedPlan?: string) {
  vi.doMock("@clerk/nextjs", () => ({
    useAuth: () => ({
      isLoaded: true,
      isSignedIn: true,
      userId: "user_123",
      has: () => false,
    }),
    useUser: () => ({
      user: {
        publicMetadata: selectedPlan ? { selectedPlan } : {},
      },
    }),
  }));
}

async function loadBillingSection(selectedPlan?: string) {
  vi.resetModules();
  installClerkMock(selectedPlan);
  return await import("../../shell/src/components/settings/sections/BillingSection.js");
}

describe("BillingPanel preselect from publicMetadata", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("preselects Max profile when publicMetadata.selectedPlan is matrix_max", async () => {
    const { BillingSection } = await loadBillingSection("matrix_max");

    render(<BillingSection />);

    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());

    // Open the computer picker dropdown
    fireEvent.click(screen.getByRole("button", { name: "Change computer" }));

    // Max profile (CPX52) should be aria-pressed="true"
    const maxButton = screen.getByRole("button", { name: /Max/ });
    expect(maxButton.getAttribute("aria-pressed")).toBe("true");

    // Builder profile (CPX32) should NOT be selected
    const builderButton = screen.getByRole("button", { name: /Builder/ });
    expect(builderButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("defaults to Builder profile when publicMetadata has no selectedPlan", async () => {
    const { BillingSection } = await loadBillingSection();

    render(<BillingSection />);

    await waitFor(() => expect(screen.getByText("Not active")).toBeTruthy());

    // Open the computer picker dropdown
    fireEvent.click(screen.getByRole("button", { name: "Change computer" }));

    // Builder profile (CPX32, index 1) should be aria-pressed="true"
    const builderButton = screen.getByRole("button", { name: /Builder/ });
    expect(builderButton.getAttribute("aria-pressed")).toBe("true");

    // Max profile (CPX52) should NOT be selected
    const maxButton = screen.getByRole("button", { name: /Max/ });
    expect(maxButton.getAttribute("aria-pressed")).toBe("false");
  });
});
