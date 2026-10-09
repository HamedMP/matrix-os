// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ProviderUsage } from "@matrix-os/contracts";
import { usageLines } from "../../packages/ui/src/agents-providers/utils";
import { AllowanceMeter } from "../../packages/ui/src/agents-providers/AllowanceMeter";

afterEach(cleanup);
it.each([[0, 10000], [2500, 7500], [7100, 2900], [7149, 2851], [7150, 2850], [7151, 2849], [10000, 0]])(
  "shows remaining allowance when %i basis points are used",
  (usedBasisPoints, remainingBasisPoints) => {
    const usage: ProviderUsage = {
      kind: "subscription_allowance", authority: "provider_allowance", state: "current",
      scope: "account", usedBasisPoints, resetsAt: null, asOf: "2026-10-02T12:00:00Z",
    };
    const lines = usageLines(usage);
    render(<><strong>{lines.primary}</strong><AllowanceMeter label="Personal" usage={usage} /></>);
    expect(screen.getByText(`${Math.round(remainingBasisPoints / 100)}% left`)).toBeVisible();
    const meter = screen.getByRole("progressbar", { name: "Personal remaining allowance" });
    expect(meter).toHaveAttribute("value", String(remainingBasisPoints));
    expect(meter).toHaveAttribute("max", "10000");
    expect(meter).toHaveAttribute("aria-valuetext", `${Math.round(remainingBasisPoints / 100)}% remaining`);
  },
);
it("does not invent remaining allowance when usage is unavailable", () => {
  render(<AllowanceMeter label="Personal" usage={{
    kind: "unavailable", authority: "unavailable", state: "unavailable",
    scope: "account", reason: "provider_does_not_report", asOf: null,
  }} />);
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

it("preserves reset and stale confirmation for remaining allowance", () => {
  expect(usageLines({
    kind: "subscription_allowance", authority: "provider_allowance", state: "stale",
    scope: "account", usedBasisPoints: 7100, resetsAt: "2026-10-14T12:00:00Z",
    asOf: "2026-10-02T12:00:00Z",
  })).toEqual({ primary: "29% left", secondary: "Resets Oct 14, 2026", stale: true });
});
