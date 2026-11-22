// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName, active, findRequest }: { sessionName: string; active?: boolean; findRequest?: number }) => (
    <div data-testid="terminal-view" data-active={active === false ? "false" : "true"} data-find={findRequest ?? 0}>{sessionName}</div>
  ),
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { nearestEdge } from "@desktop/renderer/src/features/terminal-window/TerminalPaneTree";

// Spec 2706 layer 6: one terminal per pane, split, focus, swap, zoom, close,
// resize and drag to re-split, saved per machine and restored.

type Fact = { id: string; title: string; status: null; statusAt: number; turn: number; seenTurn: null; finished: boolean };
const fact = (id: string, title: string): Fact => ({ id, title, status: null, statusAt: Date.now(), turn: 0, seenTurn: null, finished: false });

function installOperator(initial: Fact[], options: { hold?: () => Promise<void> } = {}) {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  let facts = [...initial];
  let next = 10;
  const invoke = vi.fn(async (channel: string) => {
    if (channel === "auth:status") return { signedIn: false, platformHost: "https://app.matrix-os.com", authGeneration: 0 };
    if (channel === "state:get") return { value: null };
    if (channel === "app:get-zoom") return { factor: 1 };
    if (channel === "local-terminal:watch") return { status: "ready", terminals: facts };
    if (channel === "local-terminal:create") {
      await options.hold?.();
      const id = `t${next++}`;
      facts = [...facts, fact(id, `shell ${id}`)];
      queueMicrotask(() => emit("local-terminal:facts", { terminals: facts }));
      return { status: "ready", id };
    }
    return { ok: true };
  });
  const emit = (channel: string, payload: unknown) => { for (const listener of listeners.get(channel) ?? []) listener(payload); };
  window.operator = {
    invoke,
    on: (channel, callback) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== callback));
    },
  };
  return {
    invoke,
    command: (command: Record<string, unknown>) => act(() => emit("terminal-window:command", command)),
    push: (terminals: Fact[]) => { facts = terminals; act(() => emit("local-terminal:facts", { terminals })); },
  };
}

const panes = () => screen.queryAllByRole("region").filter((element) => element.hasAttribute("data-pane"));
const paneNames = () => panes().map((pane) => pane.getAttribute("aria-label"));
const focusedPane = () => panes().find((pane) => pane.hasAttribute("data-focused"))?.getAttribute("aria-label");

async function openFirst(name: string) {
  const sidebar = await screen.findByRole("navigation", { name: "Terminals" });
  fireEvent.click(await within(sidebar).findByRole("button", { name: new RegExp(name) }));
}

describe("Terminal window panes", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); window.localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("splits right and down with a new terminal each, focuses it, and restores the layout", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    const first = render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(paneNames()).toEqual(["editor", "shell t10"]));
    expect(focusedPane()).toBe("shell t10");
    operator.command({ command: "split-down" });
    await waitFor(() => expect(paneNames()).toEqual(["editor", "shell t10", "shell t11"]));
    // Only the focused pane holds the live attachment.
    expect(screen.getAllByTestId("terminal-view").map((view) => [view.textContent, view.getAttribute("data-active")]))
      .toEqual([["local:t1", "false"], ["local:t10", "false"], ["local:t11", "true"]]);
    first.unmount();

    render(<TerminalWindowApp />);
    await openFirst("editor");
    await waitFor(() => expect(paneNames()).toEqual(["editor", "shell t10", "shell t11"]));
    expect(focusedPane()).toBe("editor");
  });

  it("moves focus and swaps by direction, zooms, and closes a pane without ending its terminal", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(paneNames()).toHaveLength(2));
    operator.command({ command: "focus-pane", direction: "left" });
    expect(focusedPane()).toBe("editor");
    operator.command({ command: "swap-pane", direction: "right" });
    expect(paneNames()).toEqual(["shell t10", "editor"]);
    expect(focusedPane()).toBe("editor");
    operator.command({ command: "zoom-pane" });
    expect(paneNames()).toEqual(["editor"]);
    operator.command({ command: "zoom-pane" });
    operator.command({ command: "close-pane" });
    await waitFor(() => expect(panes()).toHaveLength(0));
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t10");
    expect(operator.invoke).not.toHaveBeenCalledWith("local-terminal:kill", expect.anything());
    // The closed pane's terminal is still listed.
    expect(within(screen.getByRole("navigation", { name: "Terminals" })).getByRole("button", { name: /editor/ })).toBeTruthy();
  });

  it("drags a pane onto another pane's edge to split there, and Escape (no drop) changes nothing", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(paneNames()).toHaveLength(2));
    operator.command({ command: "split-down" });
    await waitFor(() => expect(paneNames()).toHaveLength(3));
    const [editor, , bottom] = panes();
    vi.spyOn(editor!, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });

    const handle = within(bottom!).getByRole("button", { name: "Move shell t11" });
    fireEvent.dragStart(handle);
    fireEvent.dragEnd(handle);
    expect(paneNames()).toEqual(["editor", "shell t10", "shell t11"]);

    fireEvent.dragStart(handle);
    // jsdom's drag events carry no pointer position: the top-left corner reads as the left edge.
    fireEvent.dragOver(editor!);
    expect(editor!.querySelector("[data-drop-edge]")?.getAttribute("data-drop-edge")).toBe("left");
    fireEvent.drop(editor!);
    expect(paneNames()).toEqual(["shell t11", "editor", "shell t10"]);
    expect(focusedPane()).toBe("shell t11");
  });

  it("resizes with the divider and drops a pane whose terminal is gone", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(paneNames()).toHaveLength(2));
    const divider = screen.getByRole("separator", { name: "Resize panes" });
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider.getAttribute("aria-valuenow")).toBe("55");
    operator.command({ command: "focus-pane", direction: "left" });
    operator.push([fact("t1", "editor")]);
    await waitFor(() => expect(panes()).toHaveLength(0));
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
  });

  it("refuses a split past 16 panes", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    for (let index = 0; index < 15; index += 1) {
      operator.command({ command: index % 2 ? "split-down" : "split-right" });
      await waitFor(() => expect(paneNames()).toHaveLength(index + 2));
      // One start at a time, as from the + menu.
      await waitFor(() => expect(screen.getByRole("button", { name: "New terminal" }).hasAttribute("disabled")).toBe(false));
    }
    operator.command({ command: "split-right" });
    expect(await screen.findByText("A tab holds at most 16 panes.")).toBeTruthy();
    expect(operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:create")).toHaveLength(15);
  });

  // Fault detected (Greptile, #3569): a split that finished after another pane change replaced it.
  it("applies a slow split to the layout as it is when the terminal is ready", async () => {
    let release: () => void = () => undefined;
    let holding = false;
    const operator = installOperator([fact("t1", "editor")], { hold: () => (holding ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve()) });
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(paneNames()).toEqual(["editor", "shell t10"]));
    operator.command({ command: "focus-pane", direction: "left" });
    holding = true;
    operator.command({ command: "split-down" });
    await waitFor(() => expect(operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:create")).toHaveLength(2));
    // While the terminal starts, the person swaps the two panes.
    operator.command({ command: "swap-pane", direction: "right" });
    expect(paneNames()).toEqual(["shell t10", "editor"]);
    await act(async () => { release(); });
    await waitFor(() => expect(paneNames()).toEqual(["shell t10", "editor", "shell t11"]));
  });

  // Fault detected (Greptile, #3569): removing the selected terminal hid the rest of its tab.
  it("keeps a tab's other panes and selects one when the selected terminal goes away", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(paneNames()).toHaveLength(2));
    operator.command({ command: "split-down" });
    await waitFor(() => expect(paneNames()).toHaveLength(3));
    operator.push([fact("t1", "editor"), fact("t10", "shell t10")]);
    await waitFor(() => expect(paneNames()).toEqual(["editor", "shell t10"]));
    expect(focusedPane()).toBeTruthy();
  });

  // Fault detected (Greptile, #3569): focusing another pane after Cmd+F opened Find there.
  it("keeps a find request with the pane it was made on", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(paneNames()).toHaveLength(2));
    operator.command({ command: "find" });
    const finds = () => screen.getAllByTestId("terminal-view").map((view) => [view.textContent, view.getAttribute("data-find")]);
    expect(finds()).toEqual([["local:t1", "0"], ["local:t10", "1"]]);
    operator.command({ command: "focus-pane", direction: "left" });
    expect(finds()).toEqual([["local:t1", "0"], ["local:t10", "1"]]);
  });

  it("picks the drop edge nearest the pointer", () => {
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    expect([nearestEdge(rect, 5, 50), nearestEdge(rect, 95, 50), nearestEdge(rect, 50, 4), nearestEdge(rect, 50, 97)]).toEqual(["left", "right", "up", "down"]);
  });
});
