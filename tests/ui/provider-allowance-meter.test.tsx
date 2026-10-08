// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ProviderUsage } from "@matrix-os/contracts";
import { AllowanceMeter } from "../../packages/ui/src/agents-providers/AllowanceMeter";

afterEach(cleanup);
it.each([[0, 10000], [2500, 7500], [10000, 0]])(
  "shows remaining allowance when %i basis points are used",
  (usedBasisPoints, remainingBasisPoints) => {
    const usage: ProviderUsage = {
      kind: "subscription_allowance", authority: "provider_allowance", state: "current",
      scope: "account", usedBasisPoints, resetsAt: null, asOf: "2026-10-02T12:00:00Z",
    };
    render(<AllowanceMeter label="Personal" usage={usage} />);
    const meter = screen.getByRole("progressbar", { name: "Personal remaining allowance" });
    expect(meter).toHaveAttribute("value", String(remainingBasisPoints));
    expect(meter).toHaveAttribute("max", "10000");
    expect(meter).toHaveAttribute("aria-valuetext", `${remainingBasisPoints / 100}% remaining`);
  },
);
it("does not invent remaining allowance when usage is unavailable", () => {
  render(<AllowanceMeter label="Personal" usage={{
    kind: "unavailable", authority: "unavailable", state: "unavailable",
    scope: "account", reason: "provider_does_not_report", asOf: null,
  }} />);
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});
