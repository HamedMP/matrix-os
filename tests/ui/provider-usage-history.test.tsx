// @vitest-environment jsdom
import React from "react";
import type { AiCreditHistoryResponse } from "@matrix-os/contracts";
import "@testing-library/jest-dom/vitest";
import {
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
