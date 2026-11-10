// @vitest-environment jsdom
import React from "react";
import { chooseOption } from "./choose-option";
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

it("reports counters it had to leave out of a selected file as incomplete, not as a clean total", async () => {
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const total = { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 };
  // A native record without thread totals cannot place the cumulative counter that follows it.
  const transcript =
    line({ type: "session_meta", timestamp: "2026-11-09T12:00:00Z", payload: { id: "thread" } }) +
    line({ type: "token_usage_record", timestamp: "2026-11-09T12:00:01Z", payload: { response_id: "r1", thread_id: "thread", usage: total } }) +
    line({ type: "event_msg", timestamp: "2026-11-09T12:00:02Z", payload: { type: "token_count", info: { total_token_usage: total } } });
  render(<AiUsagePanel now={new Date("2026-11-09T13:00:00Z")} timeZone="UTC" />);
  fireEvent.change(screen.getByLabelText("Choose usage files"), {
    // jsdom's File has no stream(); supply the bytes through the same reader interface the browser gives.
    target: { files: [Object.assign(new File([transcript], "rollout.jsonl"), { stream: () => ({ getReader: () => {
      let sent = false;
      return {
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: Uint8Array.from(Buffer.from(transcript)) })),
        cancel: async () => {},
        releaseLock: () => {},
      };
    } }) })] },
  });
  await waitFor(() => expect(screen.getByTestId("token-total").textContent).toBe("1,050"));
  expect(screen.getByText(/1 incomplete, conflicting or unsupported records/)).toBeTruthy();
});

it("counts one unplaced counter once whether it arrives from a scan, an export file or both", async () => {
  const cumulative = { input: 1000, cached: 200, output: 50 };
  const raw = [
    { id: "codex-response:r1", session: "thread", agent: "codex" as const, model: "gpt-5.5", timestamp: "2026-11-09T12:00:01Z", input: 800, cachedInput: 200, cacheWrite: 0, output: 50, sourceKind: "response" as const },
    { id: "codex:thread:1000:200:50", session: "thread", agent: "codex" as const, model: "gpt-5.5", timestamp: "2026-11-09T12:00:02Z", input: 800, cachedInput: 200, cacheWrite: 0, output: 50, sourceKind: "cumulative" as const, cumulative },
  ];
  const view = render(<AiUsagePanel initialEvents={raw} now={new Date("2026-11-09T13:00:00Z")} timeZone="UTC" />);
  expect(screen.getByTestId("token-total").textContent).toBe("1,050");
  expect(screen.getByText(/· 1 incomplete, conflicting or unsupported records/)).toBeTruthy();
  view.unmount();
  render(<AiUsagePanel now={new Date("2026-11-09T13:00:00Z")} timeZone="UTC" />);
  const exported = JSON.stringify({ version: 1, events: raw, issues: 0 });
  fireEvent.change(screen.getByLabelText("Choose usage files"), {
    target: { files: [Object.assign(new File([exported], "usage.json"), { text: async () => exported })] },
  });
  await waitFor(() => expect(screen.getByTestId("token-total").textContent).toBe("1,050"));
  expect(screen.getByText(/· 1 incomplete, conflicting or unsupported records/)).toBeTruthy();
});
