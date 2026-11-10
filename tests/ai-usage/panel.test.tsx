// @vitest-environment jsdom
import React from "react";
import { chooseOption } from "./choose-option";
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AiUsagePanel } from "../../packages/ui/src/ai-usage/AiUsagePanel";
import { createHistoryReports } from "../../packages/contracts/src/ai-usage/history-report";
import type { UsageEvent } from "../../packages/contracts/src/ai-usage/types";
afterEach(cleanup);
const events: UsageEvent[] = [
  {
    id: "1",
    session: "1",
    agent: "claude",
    model: "unknown",
    timestamp: "2026-11-09T12:00:00Z",
    input: 100,
    output: 20,
    cachedInput: 30,
    cacheWrite: 0,
  },
  {
    id: "2",
    session: "2",
    agent: "codex",
    model: "gpt-5.3-codex",
    timestamp: "2026-11-09T12:00:00Z",
    input: 200,
    output: 50,
    cachedInput: 50,
    cacheWrite: 0,
  },
];
describe("AI usage Settings", () => {
  it("shows an honest empty state and local file action", () => {
    render(
      <AiUsagePanel now={new Date("2026-11-09T13:00:00Z")} timeZone="UTC" />,
    );
    expect(screen.getByText("Your AI activity, in one place.")).toBeTruthy();
    expect(screen.getByLabelText("Choose usage files")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });
  it("filters all summary cards and model rows by coding agent", () => {
    render(
      <AiUsagePanel
        initialEvents={events}
        now={new Date("2026-11-09T13:00:00Z")}
        timeZone="UTC"
      />,
    );
    expect(screen.getByTestId("token-total").textContent).toBe("450");
    chooseOption("Coding agent", "Claude Code");
    expect(screen.getByTestId("token-total").textContent).toBe("150");
    expect(screen.queryByText("gpt-5.3-codex")).toBeNull();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  });
});
it("blocks private usage totals, dates and models from session replay", () => {
  render(
    <AiUsagePanel
      initialEvents={events}
      now={new Date("2026-11-09T12:00:00Z")}
    />,
  );
  expect(
    screen
      .getByRole("region", { name: "Personal AI usage" })
      .classList.contains("ph-no-capture"),
  ).toBe(true);
});

it("keeps a valid range when refresh removes the selected historical year and shows report freshness", () => {
 const history = (old: boolean) => {
  const builder = createHistoryReports(old ? "2023-01-01T00:00:00Z" : events[0].timestamp, "UTC", new Date("2026-11-09T12:00:00Z"));
  if (old) builder.push({...events[0], id:"old", timestamp:"2023-01-01T12:00:00Z"});
  for (const event of events) builder.push(event);
  return {timeZone:"UTC", reports:builder.finish(), coverage:{machines:["Mac"], files:2, bytes:100, indexedBytes:100, oldest:events[0].timestamp, newest:events[0].timestamp, issues:0, failedRoots:0, indexedAt:"2026-11-08T07:45:00Z"}};
 };
 const view = render(<AiUsagePanel history={history(true)} />);
 chooseOption("Date range", "2023");
 expect(screen.getByTestId("token-total").textContent).toBe("150");
 view.rerender(<AiUsagePanel history={history(false)} />);
 expect(screen.getByRole("combobox", {name:"Date range"}).textContent).toBe("All recovered coding history");
 expect(screen.getByTestId("token-total").textContent).toBe("450");
 expect(screen.getByText("Report updated")).toBeTruthy();
 expect(screen.getByText(/Nov 8, 2026.*7:45/)).toBeTruthy();
});
