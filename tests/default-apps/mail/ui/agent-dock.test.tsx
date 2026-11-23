// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWorkspace } from "./harness";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("agent panel dock", () => {
  it("opens from the title bar, explains a host without a model, and closes with Escape back to its button", async () => {
    await renderWorkspace([]);
    const toggle = screen.getByRole("button", { name: "Mail agent" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const panel = await screen.findByText(/The assistant is not available here/);
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText(/The assistant is not available here/)).toBeNull());
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("closes when its button is clicked again", async () => {
    await renderWorkspace([]);
    const toggle = screen.getByRole("button", { name: "Mail agent" });
    fireEvent.click(toggle);
    await screen.findByText(/The assistant is not available here/);
    fireEvent.click(toggle);
    expect(screen.queryByText(/The assistant is not available here/)).toBeNull();
  });
});

describe("empty folder", () => {
  it("offers a refresh that reloads the list", async () => {
    const { provider } = await renderWorkspace([]);
    const list = screen.getByRole("region", { name: "Conversation list" });
    expect(within(list).getByText("Nothing here")).toBeTruthy();
    const before = provider.calls.listThreads.length;
    await act(async () => {
      fireEvent.click(within(list).getByRole("button", { name: "Refresh" }));
    });
    expect(provider.calls.listThreads.length).toBeGreaterThan(before);
  });
});
