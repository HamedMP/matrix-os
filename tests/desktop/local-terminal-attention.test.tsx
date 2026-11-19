// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLocalTerminals } from "@desktop/renderer/src/features/terminal-window/use-local-terminals";
import { Toaster } from "sonner";
import { LocalTerminalAttention } from "@desktop/renderer/src/features/terminal-window/LocalTerminalAttention";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
// sonner renders a toast on the next macrotask.
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
it("updates one local request and opens the existing terminal", async () => {
  const onOpen = vi.fn();
  const view = render(<><Toaster /><LocalTerminalAttention state={{ status: "ready", terminals: [{ id: "t7", title: "agent-a", status: "working" }] }} activeId="t7" onOpen={onOpen} /></>);
  view.rerender(<><Toaster /><LocalTerminalAttention state={{ status: "ready", terminals: [{ id: "t7", title: "agent-a", status: "blocked", statusMessage: "approve the migration?" }] }} activeId="t7" onOpen={onOpen} /></>);
  await flush();
  expect(screen.getByRole("alert").textContent).toContain("agent-a needs you: approve the migration?");
  view.rerender(<><Toaster /><LocalTerminalAttention state={{ status: "ready", terminals: [{ id: "t7", title: "agent-a", status: "blocked", statusMessage: "approve v2?" }] }} activeId="t7" onOpen={onOpen} /></>);
  await flush();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain("approve v2?");
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await flush();
  expect(onOpen).toHaveBeenCalledWith("t7");
  // A dismissed toast animates out before it leaves the host.
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
it("shows completion only away and does not replay a disconnected baseline", async () => {
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const state = (status: "working" | "done") => ({ status: "ready" as const, terminals: [{ id: "t7", title: "agent-a", status }] });
  const view = render(<><Toaster /><LocalTerminalAttention state={state("working")} activeId="t7" onOpen={vi.fn()} /></>);
  view.rerender(<><Toaster /><LocalTerminalAttention state={state("done")} activeId="t7" onOpen={vi.fn()} /></>);
  await flush();
  expect(screen.queryByTestId("terminal-attention")).toBeNull();
  view.rerender(<><Toaster /><LocalTerminalAttention state={state("working")} activeId="t7" onOpen={vi.fn()} /></>);
  await flush();
  focus.mockReturnValue(false);
  view.rerender(<><Toaster /><LocalTerminalAttention state={state("done")} activeId="t7" onOpen={vi.fn()} /></>);
  await flush();
  expect(screen.getByTestId("terminal-attention").textContent).toContain("agent-a finished");
  act(() => { fireEvent.click(screen.getByRole("button", { name: "Dismiss agent-a" })); });
  await flush();
  view.rerender(<><Toaster /><LocalTerminalAttention state={{ status: "unavailable" }} activeId="t7" onOpen={vi.fn()} /></>);
  await flush();
  view.rerender(<><Toaster /><LocalTerminalAttention state={state("done")} activeId="t7" onOpen={vi.fn()} /></>);
  await flush();
  await waitFor(() => expect(screen.queryByTestId("terminal-attention")).toBeNull());
});

function LocalAttentionFromCore() {
  const local = useLocalTerminals();
  return <><Toaster /><LocalTerminalAttention state={local.state} activeId="t7" onOpen={() => undefined} /></>;
}
it("observes core completion while hidden before focus returns", async () => {
  vi.useFakeTimers();
  let status: "working" | "done" = "working";
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const previous = window.operator;
  window.operator = { invoke: vi.fn(async () => ({ status: "ready", terminals: [{ id: "t7", title: "agent-a", status }] })), on: () => () => undefined };
  try {
    render(<LocalAttentionFromCore />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    visibility.mockReturnValue("hidden"); focus.mockReturnValue(false); status = "done";
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    // sonner renders the toast on the next macrotask.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId("terminal-attention").textContent).toContain("agent-a finished");
    visibility.mockReturnValue("visible"); focus.mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    // sonner renders the toast on the next macrotask.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId("terminal-attention").textContent).toContain("agent-a finished");
  } finally { window.operator = previous; }
});
