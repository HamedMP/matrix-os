// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AiUsagePanel } from "../../packages/ui/src/ai-usage/AiUsagePanel";
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
    fireEvent.change(screen.getByLabelText("Coding agent"), {
      target: { value: "claude" },
    });
    expect(screen.getByTestId("token-total").textContent).toBe("150");
    expect(screen.queryByText("gpt-5.3-codex")).toBeNull();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  });
});
it("blocks private usage totals, dates and models from session replay",()=>{
 render(<AiUsagePanel initialEvents={events} now={new Date("2026-11-09T12:00:00Z")} />);
 expect(screen.getByRole("region",{name:"Personal AI usage"}).classList.contains("ph-no-capture")).toBe(true);
});
