// @vitest-environment jsdom
import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutomaticAiUsagePanel } from "../../packages/ui/src/ai-usage/AutomaticAiUsagePanel";
afterEach(cleanup);
it("discovers usage on opening Settings without choosing files", async () => {
  const load = vi.fn(async () => ({
    version: 1 as const,
    issues: 0,
    events: [
      {
        id: "e",
        session: "s",
        agent: "codex" as const,
        model: "gpt-5",
        timestamp: new Date().toISOString(),
        input: 15,
        cachedInput: 5,
        cacheWrite: 0,
        output: 3,
      },
    ],
  }));
  render(<AutomaticAiUsagePanel load={load} sourceLabel="This computer" />);
  await waitFor(() =>
    expect(screen.getByTestId("token-total").textContent).toBe("23"),
  );
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("Choose usage files")).toBeNull();
});
it("ignores late discovery after its owner/computer scope unmounts", async () => {
  let finish!: (v: { version: 1; issues: number; events: [] }) => void;
  const load = vi.fn(
    () =>
      new Promise<{ version: 1; issues: number; events: [] }>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <AutomaticAiUsagePanel load={load} sourceLabel="First computer" />,
  );
  view.unmount();
  finish({ version: 1, issues: 0, events: [] });
  render(
    <AutomaticAiUsagePanel
      load={async () => {
        throw new Error("private path");
      }}
      sourceLabel="Second computer"
    />,
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Automatic usage scan is unavailable. Retry or connect to a computer with the latest Matrix version.",
  );
  expect(screen.queryByText("private path")).toBeNull();
});
it("replaces displayed counters when Refresh discovers new usage", async () => {
  const { fireEvent } = await import("@testing-library/react");
  let input = 2;
  const load = async () => ({
    version: 1 as const,
    issues: 0,
    events: [
      {
        id: "e",
        session: "s",
        agent: "codex" as const,
        model: "gpt-5",
        timestamp: new Date().toISOString(),
        input,
        cachedInput: 0,
        cacheWrite: 0,
        output: 0,
      },
    ],
  });
  render(<AutomaticAiUsagePanel load={load} sourceLabel="This computer" />);
  await waitFor(() =>
    expect(screen.getByTestId("token-total").textContent).toBe("2"),
  );
  input = 9;
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  await waitFor(() =>
    expect(screen.getByTestId("token-total").textContent).toBe("9"),
  );
});
it("handles an invalid auto-scan response at the async boundary", async () => {
  render(
    <AutomaticAiUsagePanel
      load={async () => ({}) as never}
      sourceLabel="This computer"
    />,
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(
    await screen.findByText("Your AI activity, in one place."),
  ).toBeTruthy();
});

it("shows all-time indexed history and backup coverage when the server returns aggregated reports", async () => {
  const { createHistoryReports } = await import(
    "../../packages/contracts/src/ai-usage/history-report"
  );
  const builder = createHistoryReports(
    "2023-01-01T00:00:00Z",
    "UTC",
    new Date("2026-11-09T00:00:00Z"),
  );
  builder.push({
    id: "old",
    session: "s",
    agent: "claude",
    model: "unknown",
    timestamp: "2023-01-01T12:00:00Z",
    input: 10,
    cachedInput: 0,
    cacheWrite: 0,
    output: 20,
  });
  render(
    <AutomaticAiUsagePanel
      sourceLabel="Mac + Matrix"
      load={async () => ({
        version: 1,
        events: [],
        issues: 0,
        history: {
          reports: builder.finish(),
          coverage: {
            machines: ["Mac", "Matrix"],
            files: 10,
            bytes: 1024,
            indexedBytes: 1024,
            oldest: "2023-01-01T00:00:00Z",
            newest: "2023-01-01T12:00:00Z",
            issues: 0,
            failedRoots: 0,
            indexedAt: "2026-11-09T00:00:00Z",
            backup: {
              verifiedFiles: 10,
              verifiedBytes: 1024,
              verifiedAt: "2026-11-09T00:00:00Z",
            },
          },
        },
      })}
    />,
  );
  expect(await screen.findByText("All available history")).toBeTruthy();
  expect(screen.getByTestId("token-total").textContent).toBe("30");
  expect(screen.getByText(/10 files verified on Matrix/)).toBeTruthy();
  const disclosure = screen.getByText("Details").closest("details")!;
  expect(disclosure.open).toBe(false);
  fireEvent.click(screen.getByText("Details"));
  expect(disclosure.open).toBe(true);
});
