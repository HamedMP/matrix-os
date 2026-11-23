// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The attach managers the panes' terminals were given, to check each pane streams on its own.
const managers = vi.hoisted(() => new Map<string, unknown>());
// How many times each terminal's view was mounted, to catch a pane that remounts (and loses its screen).
const mounts = vi.hoisted(() => new Map<string, number>());
// How many times each terminal's view rendered, to catch panes redrawing on status updates.
const renders = vi.hoisted(() => new Map<string, number>());

vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName, active, focused, attachManager, findRequest, onPaneAction }: {
    sessionName: string; active?: boolean; focused?: boolean; attachManager?: unknown; findRequest?: number; onPaneAction?: (action: unknown) => void;
  }) => {
    managers.set(sessionName, attachManager);
    renders.set(sessionName, (renders.get(sessionName) ?? 0) + 1);
    // eslint-disable-next-line react-hooks/rules-of-hooks -- a test double counting its own mounts
    React.useEffect(() => { mounts.set(sessionName, (mounts.get(sessionName) ?? 0) + 1); }, [sessionName]);
    return (
      <div data-testid="terminal-view" data-active={active === false ? "false" : "true"} data-focused={focused ? "true" : "false"} data-find={findRequest ?? 0}>
        {sessionName}
        {focused ? <button type="button" aria-label="Pane split right" onClick={() => onPaneAction?.({ type: "split", direction: "right" })} /> : null}
      </div>
    );
  },
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { nearestEdge } from "@desktop/renderer/src/features/terminal-window/TerminalPaneTree";
import { MAX_PANES_PER_TAB, splitPane, type PaneTab } from "@matrix-os/ui/terminal-pane-tree";
import { MAX_OPEN_TABS, openTerminal } from "@desktop/renderer/src/features/terminal-window/use-open-tabs";

// Spec 2706 layer 6: one terminal per pane, split, focus, swap, zoom, close,
// resize and drag to re-split, saved per machine and restored.

type Fact = { id: string; title: string; status: null; statusAt: number; turn: number; seenTurn: null; finished: boolean };
const fact = (id: string, title: string): Fact => ({ id, title, status: null, statusAt: Date.now(), turn: 0, seenTurn: null, finished: false });

function installOperator(initial: Fact[], options: { hold?: () => Promise<void> } = {}) {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  let facts = [...initial];
  let next = 10;
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
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
    if (channel === "local-terminal:remove") {
      const { id } = payload as { id: string };
      facts = facts.filter((entry) => entry.id !== id);
      queueMicrotask(() => emit("local-terminal:facts", { terminals: facts }));
      return { ok: true };
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
const viewNames = () => screen.getAllByTestId("terminal-view").map((view) => view.firstChild?.textContent);
const paneNames = () => panes().map((pane) => pane.getAttribute("aria-label"));
const focusedPane = () => panes().find((pane) => pane.hasAttribute("data-focused"))?.getAttribute("aria-label");

async function openFirst(name: string) {
  const sidebar = await screen.findByRole("navigation", { name: "Terminals" });
  fireEvent.click(await within(sidebar).findByRole("button", { name: new RegExp(name) }));
}

beforeAll(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

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
    // Fault detected (Hamed, 2026-11-22): only the focused pane streamed; the others froze.
    // Every pane is live on an attachment of its own, and only the focused one takes the keyboard.
    await waitFor(() => expect(screen.getAllByTestId("terminal-view").map((view) => [view.textContent, view.getAttribute("data-active"), view.getAttribute("data-focused")]))
      .toEqual([["local:t1", "true", "false"], ["local:t10", "true", "false"], ["local:t11", "true", "true"]]));
    const attached = ["local:t1", "local:t10", "local:t11"].map((name) => managers.get(name));
    expect(attached.every(Boolean)).toBe(true);
    expect(new Set(attached).size).toBe(3);
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
    // Fault detected (Greptile, #3569): zoom unmounted the other panes, losing their screens.
    expect(panes().filter((pane) => pane.hasAttribute("data-zoomed")).map((pane) => pane.getAttribute("aria-label"))).toEqual(["editor"]);
    expect(screen.getAllByTestId("terminal-view", { hidden: true })).toHaveLength(2);
    // Fault detected (Greptile, #3569): the divider under a zoomed pane still took focus and arrow keys.
    const divider = document.querySelector<HTMLElement>('[role=separator][aria-label="Resize panes"]')!;
    expect(divider.tabIndex).toBe(-1);
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    operator.command({ command: "zoom-pane" });
    expect(panes().some((pane) => pane.hasAttribute("data-zoomed"))).toBe(false);
    expect(document.querySelector<HTMLElement>('[role=separator][aria-label="Resize panes"]')!.tabIndex).toBe(0);
    operator.command({ command: "close-pane" });
    // The terminal left on its own is a one-pane tab, header and all.
    await waitFor(() => expect(paneNames()).toEqual(["shell t10"]));
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
    // Settled: the third pane is in and has taken focus.
    await waitFor(() => expect(focusedPane()).toBe("shell t11"));
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
    await waitFor(() => expect(paneNames()).toEqual(["editor"]));
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
  });

  // Hamed, 2026-11-22: Herdr's panes have a header with split, zoom and close on every pane.
  it("gives a terminal on its own a pane header, and outlines the focused pane in blue", async () => {
    installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    const [pane] = await waitFor(() => { expect(panes()).toHaveLength(1); return panes(); });
    for (const name of ["Split right pane editor", "Split down pane editor", "Zoom pane editor", "Close pane editor"]) {
      expect(within(pane!).getByRole("button", { name })).toBeTruthy();
    }
    expect(pane!.style.borderColor).toBe("rgb(59, 130, 246)");
  });

  it("splits, zooms and closes from a pane header, on that pane even when another has focus", async () => {
    const operator = installOperator([fact("t1", "editor")], {});
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(focusedPane()).toBe("shell t10"));
    fireEvent.click(screen.getByRole("button", { name: "Split down pane editor" }));
    // The new pane goes under editor, not under the focused shell.
    await waitFor(() => expect(paneNames()).toEqual(["editor", "shell t11", "shell t10"]));
    expect(focusedPane()).toBe("shell t11");
    fireEvent.click(screen.getByRole("button", { name: "Zoom pane shell t10" }));
    expect(panes().filter((pane) => pane.hasAttribute("data-zoomed")).map((pane) => pane.getAttribute("aria-label"))).toEqual(["shell t10"]);
    fireEvent.click(screen.getByRole("button", { name: "Restore pane shell t10" }));
    expect(panes().some((pane) => pane.hasAttribute("data-zoomed"))).toBe(false);

    // Close ends that pane's terminal, asking first while it runs.
    fireEvent.click(screen.getByRole("button", { name: "Close pane editor" }));
    const dialog = await screen.findByRole("alertdialog", { name: /^End “/ });
    expect(operator.invoke).not.toHaveBeenCalledWith("local-terminal:kill", expect.anything());
    fireEvent.click(within(dialog).getByRole("button", { name: "End pane" }));
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:kill", { id: "t1" }));
    await waitFor(() => expect(paneNames()).toEqual(["shell t11", "shell t10"]));
  });

  // Hamed, 2026-11-22: Cmd+W closes the focused pane, as in Herdr, and the pane beside it takes focus.
  it("closes the focused pane on Cmd+W by ending its terminal, and focuses the pane beside it", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(focusedPane()).toBe("shell t10"));
    operator.command({ command: "close-terminal" });
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: /^End “/ })).getByRole("button", { name: "End pane" }));
    await waitFor(() => expect(paneNames()).toEqual(["editor"]));
    expect(focusedPane()).toBe("editor");
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:kill", { id: "t10" });
    // Fault detected (Mac, 2026-11-22): the closed terminal stayed listed and came back as a tab of its own.
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:remove", { id: "t10" }));
    expect(within(screen.getByRole("tablist", { name: "Open terminals" })).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["editor"]);
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Terminals" })).queryByRole("button", { name: /shell t10/ })).toBeNull());
  });

  // Fault detected (Mac, 2026-11-22): keyboard focus moved into a pane's terminal but the other pane stayed focused.
  it("makes a pane the focused one when keyboard focus moves into it", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(focusedPane()).toBe("shell t10"));
    fireEvent.focus(await within(panes()[0]!).findByTestId("terminal-view"));
    await waitFor(() => expect(focusedPane()).toBe("editor"));
  });

  // The cap itself is the model's (tests/ui/terminal-pane-tree.test.ts); here the window's split
  // command goes through it. The tab starts restored at the cap instead of 15 live splits.
  it("refuses a split past 16 panes", async () => {
    const terminals = Array.from({ length: MAX_PANES_PER_TAB }, (_, index) => fact(`p${index + 1}`, `pane ${index + 1}`));
    let counter = 0;
    let tab: PaneTab = { id: "tab1", root: { type: "leaf", id: "leaf0", terminal: "local|p1" }, focus: "leaf0", zoom: null };
    for (let index = 1; index < MAX_PANES_PER_TAB; index += 1) {
      tab = splitPane(tab, tab.focus, index % 2 ? "right" : "down", `local|p${index + 1}`, () => `n${counter++}`)!;
    }
    window.localStorage.setItem("matrix.terminal-window.panes.v1", JSON.stringify({ local: [tab] }));
    const operator = installOperator(terminals);
    render(<TerminalWindowApp />);
    await openFirst("pane 1(?!\\d)");
    await waitFor(() => expect(paneNames()).toHaveLength(16));
    operator.command({ command: "split-right" });
    expect(await screen.findByText("A tab holds at most 16 panes.")).toBeTruthy();
    expect(operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:create")).toHaveLength(0);
    // Fault detected (Greptile, #3569): with a pane's terminal gone, the split was refused against the stale tree.
    operator.push(terminals.filter((entry) => entry.id !== "p16"));
    await waitFor(() => expect(paneNames()).toHaveLength(15));
    operator.command({ command: "split-right" });
    await waitFor(() => expect(paneNames()).toHaveLength(16));
    expect(operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:create")).toHaveLength(1);
    // The new pane holds the new terminal, and every pane a terminal of its own.
    expect(paneNames()).toContain("shell t10");
    expect(new Set(paneNames()).size).toBe(16);
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

  // Hamed, 2026-11-22: the terminal's own split buttons must drive this window's panes, not Zellij.
  it("splits through the window's panes from the terminal's split button", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    fireEvent.click(await screen.findByRole("button", { name: "Pane split right" }));
    await waitFor(() => expect(paneNames()).toEqual(["editor", "shell t10"]));
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:create", { cols: 100, rows: 30 });
  });

  // Hamed, 2026-11-22: Herdr's top bar of workspaces, one tab per pane tab.
  it("shows opened terminals as top tabs, one per pane tab, and closes a tab without ending its terminals", async () => {
    const operator = installOperator([fact("t1", "editor"), fact("t2", "logs")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    await openFirst("logs");
    const bar = () => screen.getByRole("tablist", { name: "Open terminals" });
    const tabNames = () => within(bar()).getAllByRole("tab").map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]);
    await waitFor(() => expect(tabNames()).toEqual([["editor", "false"], ["logs", "true"]]));
    fireEvent.click(within(bar()).getByRole("tab", { name: /editor/ }));
    await waitFor(() => expect(paneNames()).toEqual(["editor"]));
    operator.command({ command: "split-right" });
    // A split stays one tab, counting its panes.
    // The tab's name is the focused pane's terminal, then its pane count ("2").
    await waitFor(() => expect(tabNames()).toEqual([["shell t102", "true"], ["logs", "false"]]));
    fireEvent.click(screen.getByRole("button", { name: "Close tab shell t10" }));
    await waitFor(() => expect(tabNames()).toEqual([["logs", "true"]]));
    expect(paneNames()).toEqual(["logs"]);
    expect(operator.invoke).not.toHaveBeenCalledWith("local-terminal:kill", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "New terminal tab" }));
    await waitFor(() => expect(tabNames().map(([name]) => name)).toEqual(["logs", "shell t11"]));
  });

  // Fault detected (Hamed, 2026-11-22): splitting a pane remounted the existing one and blanked its screen.
  it("never remounts a pane's terminal when panes split, close, move or change focus", async () => {
    mounts.clear();
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    await waitFor(() => expect(mounts.get("local:t1")).toBe(1));
    operator.command({ command: "split-right" });
    await waitFor(() => expect(mounts.get("local:t10")).toBe(1));
    operator.command({ command: "split-down" });
    await waitFor(() => expect(mounts.get("local:t11")).toBe(1));
    for (const direction of ["left", "right", "up", "down", "left"] as const) operator.command({ command: "focus-pane", direction });
    operator.command({ command: "swap-pane", direction: "right" });
    operator.command({ command: "zoom-pane" });
    operator.command({ command: "zoom-pane" });
    operator.command({ command: "close-pane" });
    await waitFor(() => expect(paneNames()).toHaveLength(2));
    expect([mounts.get("local:t1"), mounts.get("local:t10"), mounts.get("local:t11")]).toEqual([1, 1, 1]);
  });

  // Fault detected (Hamed, 2026-11-22, scroll lag): every status event redrew every pane's terminal.
  it("leaves pane terminals alone when terminal status changes", async () => {
    const operator = installOperator([fact("t1", "editor"), fact("t2", "logs")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(focusedPane()).toBe("shell t10"));
    await waitFor(() => expect(screen.getAllByTestId("terminal-view")).toHaveLength(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const before = [renders.get("local:t1"), renders.get("local:t10")];
    for (let turn = 1; turn <= 5; turn += 1) {
      operator.push([fact("t1", "editor"), { ...fact("t2", "logs"), turn, statusAt: Date.now() + turn }, fact("t10", "shell t10")]);
    }
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Terminals" })).toBeTruthy());
    expect([renders.get("local:t1"), renders.get("local:t10")]).toEqual(before);
  });

  // Hamed, 2026-11-22: Cmd+W closes only the focused pane; the tab and its other panes stay.
  it("closes only the focused pane of a three-pane tab on Cmd+W and focuses its neighbour", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(focusedPane()).toBe("shell t10"));
    operator.command({ command: "split-down" });
    await waitFor(() => expect(focusedPane()).toBe("shell t11"));
    operator.command({ command: "close-terminal" });
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: /^End “/ })).getByRole("button", { name: "End pane" }));
    await waitFor(() => expect(paneNames()).toEqual(["editor", "shell t10"]));
    expect(focusedPane()).toBe("shell t10");
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:kill", { id: "t11" });
    expect(within(screen.getByRole("tablist", { name: "Open terminals" })).getAllByRole("tab")).toHaveLength(1);
  });

  // Fault detected (Greptile, #3569): closing a pane picked the saved focus's neighbour, not the closed pane's.
  it("focuses the closed pane's neighbour, not the pane last saved as focused", async () => {
    const operator = installOperator([fact("t1", "editor")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    operator.command({ command: "split-right" });
    await waitFor(() => expect(focusedPane()).toBe("shell t10"));
    operator.command({ command: "split-down" });
    await waitFor(() => expect(focusedPane()).toBe("shell t11"));
    // editor | shell t10 above shell t11; the saved focus is shell t11. Close editor instead.
    operator.command({ command: "focus-pane", direction: "left" });
    await waitFor(() => expect(focusedPane()).toBe("editor"));
    operator.command({ command: "close-terminal" });
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: /^End “/ })).getByRole("button", { name: "End pane" }));
    await waitFor(() => expect(paneNames()).toEqual(["shell t10", "shell t11"]));
    expect(focusedPane()).toBe("shell t10");
  });

  // Hamed, 2026-11-22: Ctrl+Tab and Ctrl+Shift+Tab cycle the tab bar, wrapping around.
  it("cycles the open tabs in tab-bar order with Ctrl+Tab and back with Ctrl+Shift+Tab", async () => {
    const operator = installOperator([fact("t1", "editor"), fact("t2", "logs"), fact("t3", "build")]);
    render(<TerminalWindowApp />);
    await openFirst("editor");
    await openFirst("logs");
    await openFirst("build");
    const selected = () => within(screen.getByRole("tablist", { name: "Open terminals" })).getAllByRole("tab")
      .find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
    await waitFor(() => expect(selected()).toBe("build"));
    operator.command({ command: "next-tab" });
    await waitFor(() => expect(selected()).toBe("editor"));
    operator.command({ command: "next-tab" });
    await waitFor(() => expect(selected()).toBe("logs"));
    operator.command({ command: "previous-tab" });
    await waitFor(() => expect(selected()).toBe("editor"));
    operator.command({ command: "previous-tab" });
    await waitFor(() => expect(selected()).toBe("build"));
  });

  it("picks the drop edge nearest the pointer", () => {
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    expect([nearestEdge(rect, 5, 50), nearestEdge(rect, 95, 50), nearestEdge(rect, 50, 4), nearestEdge(rect, 50, 97)]).toEqual(["left", "right", "up", "down"]);
  });
});

// Fault detected (Greptile, #3569): the tab bar's cap counted terminals, so the panes of one big tab
// pushed unrelated tabs off the bar.
describe("open tabs cap", () => {
  const big = Array.from({ length: MAX_PANES_PER_TAB }, (_, index) => `big${index}`);
  const groupOf = (key: string) => ({ id: key.startsWith("big") ? "big" : key });

  it("counts tabs, not terminals, and drops the oldest whole tabs", () => {
    const solo = Array.from({ length: 9 }, (_, index) => `solo${index}`);
    let opened: readonly string[] = [...solo];
    for (const key of big) opened = openTerminal(opened, key, groupOf);
    expect(opened).toEqual([...solo, ...big]);
    const many = Array.from({ length: MAX_OPEN_TABS }, (_, index) => `t${index}`);
    let full: readonly string[] = [...big];
    for (const key of many) full = openTerminal(full, key, groupOf);
    // 25 tabs: the oldest tab (all 16 of its panes) leaves, the newest stays.
    expect(full).toEqual(many);
    expect(openTerminal(full, "t3", groupOf)).toBe(full);
  });
});
