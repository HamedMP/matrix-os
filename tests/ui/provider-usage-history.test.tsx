// @vitest-environment jsdom
import React from "react";
import type { AiCreditHistoryResponse } from "@matrix-os/contracts";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UsageHistoryDialog } from "../../packages/ui/src/agents-providers/UsageHistoryDialog";
afterEach(cleanup);
it("preserves subcent usage precision without changing ordinary credit amounts", async () => {
  const load = vi.fn().mockResolvedValue({ entries: [111, 1660, -100000].map(amount => ({
    occurredAt: "2026-10-01T00:00:00Z", kind: amount > 0 ? "usage" : "credit",
    amountMicrousd: -amount, modelId: null,
  })), nextCursor: null });
  render(<UsageHistoryDialog load={load} onClose={vi.fn()} />);
  expect(await screen.findByText("-$0.000111")).toBeInTheDocument();
  expect(screen.getByText("-$0.00166")).toBeInTheDocument();
  expect(screen.getByText("$0.10")).toBeInTheDocument();
});
it("renders authoritative history pages and safe error recovery", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce({
      entries: [
        {
          occurredAt: "2026-10-01T00:00:00Z",
          kind: "usage",
          amountMicrousd: -100000,
          modelId: "glm-5",
        },
      ],
      nextCursor: "a".repeat(32),
    })
    .mockRejectedValueOnce(new Error("private backend token"));
  render(<UsageHistoryDialog load={load} onClose={vi.fn()} />);
  await screen.findByText("glm-5");
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Usage history could not be loaded",
    ),
  );
  expect(screen.getByText("glm-5")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("private backend token");
});
it("aborts the history request when the dialog closes", () => {
  let signal: AbortSignal | undefined;
  const load = vi.fn((_: string | null, s: AbortSignal) => {
    signal = s;
    return new Promise<AiCreditHistoryResponse>(() => {});
  });
  const result = render(<UsageHistoryDialog load={load} onClose={vi.fn()} />);
  result.unmount();
  expect(signal?.aborted).toBe(true);
});

it("keeps history chrome outside the scroll region and uses readable model labels", async () => {
  const load = vi.fn().mockResolvedValue({entries: [{occurredAt: "2026-10-02T17:07:21Z", kind: "usage", amountMicrousd: -111, modelId: "@cf/zai-org/glm-5.3-flash"}], nextCursor: "a".repeat(32)});
  render(<UsageHistoryDialog load={load} onClose={vi.fn()} />);
  const model = await screen.findByText("GLM 5.3 Flash");
  expect(model).toHaveAttribute("title", "@cf/zai-org/glm-5.3-flash");
  const list = screen.getByRole("region", {name: "Credit activity"});
  expect(list).toHaveAttribute("tabindex", "0");
  expect(list).toContainElement(screen.getByRole("table"));
  expect(list).not.toContainElement(screen.getByRole("heading", {name: "Usage history"}));
  expect(list).not.toContainElement(screen.getByRole("button", {name: "Load more"}));
  expect(screen.getByText("1 activity")).toBeInTheDocument();
});

it("keeps loaded activity during pagination and traps keyboard focus in the dialog", async () => {
  let finish!: (value: AiCreditHistoryResponse) => void;
  const entry = {occurredAt: "2026-10-02T17:07:21Z", kind: "usage" as const, amountMicrousd: -111, modelId: "@cf/zai-org/glm-5.3-flash"};
  const load = vi.fn().mockResolvedValueOnce({entries: [entry], nextCursor: "a".repeat(32)}).mockImplementationOnce(() => new Promise<AiCreditHistoryResponse>(resolve => {finish = resolve;}));
  const onClose = vi.fn();
  render(<UsageHistoryDialog load={load} onClose={onClose} />);
  await screen.findByText("GLM 5.3 Flash");
  const close = screen.getByRole("button", {name: "Close"});
  close.focus();
  fireEvent.keyDown(close, {key: "Tab", shiftKey: true});
  expect(screen.getByRole("button", {name: "Load more"})).toHaveFocus();
  fireEvent.click(screen.getByRole("button", {name: "Load more"}));
  expect(screen.getByRole("button", {name: "Loading…"})).toBeDisabled();
  expect(screen.getByText("GLM 5.3 Flash")).toBeInTheDocument();
  finish({entries: [{...entry, modelId: "anthropic/claude-sonnet-5", amountMicrousd: -1660}], nextCursor: null});
  await screen.findByText("Claude Sonnet 5");
  expect(screen.getByText("2 activities")).toBeInTheDocument();
  expect(screen.getByText("All activity loaded")).toBeInTheDocument();
  fireEvent.keyDown(close, {key: "Escape"});
  expect(onClose).toHaveBeenCalledOnce();
});

it("restores focus to the opener and ignores a late response after transport changes", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  let finish!: (value: AiCreditHistoryResponse) => void;
  const oldLoad = vi.fn(() => new Promise<AiCreditHistoryResponse>(resolve => { finish = resolve; }));
  const newLoad = vi.fn().mockResolvedValue({ entries: [], nextCursor: null });
  const view = render(<UsageHistoryDialog load={oldLoad} onClose={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  view.rerender(<UsageHistoryDialog load={newLoad} onClose={vi.fn()} />);
  await screen.findByText("No activity yet");
  await act(async () => { finish({ entries: [{ occurredAt: "2026-10-01T00:00:00Z", kind: "usage", amountMicrousd: -111, modelId: "old-private-scope" }], nextCursor: null }); });
  expect(screen.queryByText("old-private-scope")).not.toBeInTheDocument();
  view.unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});
