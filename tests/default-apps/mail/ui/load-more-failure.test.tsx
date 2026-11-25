// @vitest-environment jsdom
/**
 * Fault caught: when loading the next page fails (for example the gateway's
 * shared app budget answers 429), the list must not ask again on its own.
 * Before the fix the near-end effect re-fired after every failure, so the
 * app hammered the gateway in a tight loop and froze the window.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { page } from "../model/fixtures";
import { renderWorkspace } from "./harness";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("thread list paging failure", () => {
  it("stops after one failed next page and retries only when the owner asks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const all = page("t", 200);
    const { provider } = await renderWorkspace(all, (p) => {
      p.onListThreads = async (request) => {
        if (request.cursor) throw new ProviderError("rate_limited");
        return { items: all.slice(0, 50), nextCursor: "50" };
      };
    });
    const list = screen.getByRole("grid", { name: "Conversations" });
    await act(async () => {
      list.scrollTop = 50 * 72 - 600;
      fireEvent.scroll(list);
    });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // Give a runaway effect every chance to fire again.
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const pagedCalls = () => provider.calls.listThreads.filter((call) => call.cursor).length;
    expect(pagedCalls()).toBe(1);
    expect(screen.getByText("50 conversations")).toBeTruthy();

    provider.onListThreads = async (request) => ({ items: all.slice(Number(request.cursor ?? 0), Number(request.cursor ?? 0) + 50), nextCursor: "100" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    });
    await waitFor(() => expect(screen.getByText("100 conversations")).toBeTruthy());
    expect(pagedCalls()).toBe(2);
  });
});
