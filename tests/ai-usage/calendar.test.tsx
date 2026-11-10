// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { UsageHeatmap } from "../../packages/ui/src/ai-usage/UsageHeatmap";
import { createHistoryReports } from "../../packages/contracts/src/ai-usage/history-report";
afterEach(cleanup);
it("shows every recovered day in readable year rows without losing dates at the year boundary", () => {
  const summary = createHistoryReports(
    "2025-10-06T00:00:00Z",
    "UTC",
    new Date("2026-11-09T12:00:00Z"),
  )
    .finish()
    .find((r) => r.id === "all" && r.agent === "")!.summary;
  render(<UsageHeatmap summary={summary} days={400} endDay="2026-11-09" />);
  const first = screen.getByRole("group", { name: "2025 activity" }),
    second = screen.getByRole("group", { name: "2026 activity" });
  expect(
    within(first).getAllByRole("button").length +
      within(second).getAllByRole("button").length,
  ).toBe(400);
  expect(
    within(first).getByRole("button", { name: /^2025-12-31:/ }),
  ).toBeTruthy();
  expect(
    within(second).getByRole("button", { name: /^2026-01-01:/ }),
  ).toBeTruthy();
});
