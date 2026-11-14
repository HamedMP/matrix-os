// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLocalTerminals } from "@desktop/renderer/src/features/terminal-window/use-local-terminals";
import { LocalTerminalAttention } from "@desktop/renderer/src/features/terminal-window/LocalTerminalAttention";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("updates one local request and opens the existing terminal", () => {
  const onOpen = vi.fn();
  const view = render(<LocalTerminalAttention state={{ status: "ready", terminals: [{ id: "t7", title: "agent-a", status: "working" }] }} activeId="t7" onOpen={onOpen} />);
  view.rerender(<LocalTerminalAttention state={{ status: "ready", terminals: [{ id: "t7", title: "agent-a", status: "blocked", statusMessage: "approve the migration?" }] }} activeId="t7" onOpen={onOpen} />);
  expect(screen.getByRole("alert").textContent).toContain("agent-a needs you: approve the migration?");
  view.rerender(<LocalTerminalAttention state={{ status: "ready", terminals: [{ id: "t7", title: "agent-a", status: "blocked", statusMessage: "approve v2?" }] }} activeId="t7" onOpen={onOpen} />);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain("approve v2?");
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(onOpen).toHaveBeenCalledWith("t7");
  expect(screen.queryByRole("alert")).toBeNull();
});
it("shows completion only away and does not replay a disconnected baseline", () => {
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const state = (status: "working" | "done") => ({ status: "ready" as const, terminals: [{ id: "t7", title: "agent-a", status }] });
  const view = render(<LocalTerminalAttention state={state("working")} activeId="t7" onOpen={vi.fn()} />);
  view.rerender(<LocalTerminalAttention state={state("done")} activeId="t7" onOpen={vi.fn()} />);
  expect(screen.queryByTestId("terminal-attention")).toBeNull();
  view.rerender(<LocalTerminalAttention state={state("working")} activeId="t7" onOpen={vi.fn()} />);
  focus.mockReturnValue(false);
  view.rerender(<LocalTerminalAttention state={state("done")} activeId="t7" onOpen={vi.fn()} />);
  expect(screen.getByTestId("terminal-attention").textContent).toContain("agent-a finished");
  act(() => { fireEvent.click(screen.getByRole("button", { name: "Dismiss agent-a" })); });
  view.rerender(<LocalTerminalAttention state={{ status: "unavailable" }} activeId="t7" onOpen={vi.fn()} />);
  view.rerender(<LocalTerminalAttention state={state("done")} activeId="t7" onOpen={vi.fn()} />);
  expect(screen.queryByTestId("terminal-attention")).toBeNull();
});

function LocalAttentionFromCore() {
  const local = useLocalTerminals();
  return <LocalTerminalAttention state={local.state} activeId="t7" onOpen={() => undefined} />;
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
    expect(screen.getByTestId("terminal-attention").textContent).toContain("agent-a finished");
    visibility.mockReturnValue("visible"); focus.mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.getByTestId("terminal-attention").textContent).toContain("agent-a finished");
  } finally { window.operator = previous; }
});
