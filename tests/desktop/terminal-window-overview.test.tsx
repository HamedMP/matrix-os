// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName, focused }: { sessionName: string; focused?: boolean }) => (
    <div data-testid="terminal-view" data-focused={focused ? "true" : "false"}>{sessionName}</div>
  ),
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { COMPUTER_PREVIEW_MIN_MS, previewLines, useTerminalPreviews } from "@desktop/renderer/src/features/terminal-window/use-terminal-previews";
import type { TerminalSidebarRow } from "@matrix-os/ui/terminal-status-sidebar";
import type { ApiClient } from "@desktop/renderer/src/lib/api";

// Hamed, 2026-11-22: an overview tab listing every terminal (of the active space) with inline
// rename, a live preview of each one's screen, its status, and a click to open it.
type Listener = (payload: unknown) => void;
function installOperator(screens: Record<string, string>) {
  const listeners = new Map<string, Listener[]>();
  const facts = [
    { id: "t1", title: "build", status: "working", statusAt: 1_000, turn: 0, seenTurn: null, finished: false },
    { id: "t2", title: "tests", status: "done", statusAt: 1_000, turn: 1, seenTurn: null, finished: false },
  ];
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "auth:status") return { signedIn: false, platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 0 };
    if (channel === "state:get") return { value: null };
    if (channel === "app:get-zoom") return { factor: 1 };
    if (channel === "local-terminal:watch") return { status: "ready", terminals: facts };
    if (channel === "local-terminal:read") {
      const text = screens[(payload as { id: string }).id];
      return text === undefined ? { ok: false } : { ok: true, text };
    }
    return { ok: true };
  });
  window.operator = {
    invoke,
    on: (channel, callback) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== callback));
    },
  };
  const emit = (channel: string, payload: unknown) => { for (const listener of listeners.get(channel) ?? []) listener(payload); };
  return {
    invoke,
    command: (command: Record<string, unknown>) => act(() => emit("terminal-window:command", command)),
    push: (terminals: unknown[]) => act(() => emit("local-terminal:facts", { terminals })),
    facts,
  };
}

describe("Terminal window overview", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); window.localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("lists every terminal with its status and a live preview, and opens one on a click", async () => {
    const operator = installOperator({ t1: "$ bun dev\n\n  ready on :3000\n", t2: "12 passing\n" });
    render(<TerminalWindowApp />);
    await screen.findByRole("navigation", { name: "Terminals" });
    operator.command({ command: "overview" });
    const overview = await screen.findByRole("main", { name: "Overview" });
    expect(within(overview).getByText(/All terminals/)).toBeTruthy();
    await waitFor(() => expect(within(overview).getByLabelText("build preview").textContent).toBe("$ bun dev\n  ready on :3000"));
    expect(within(overview).getByLabelText("tests preview").textContent).toBe("12 passing");
    expect(within(within(overview).getByRole("button", { name: "Open build" })).getByText("Working")).toBeTruthy();
    fireEvent.click(within(overview).getByRole("button", { name: "Open tests" }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t2");
    expect(screen.queryByRole("main", { name: "Overview" })).toBeNull();
  });

  it("renames a terminal in place and toggles from the tab bar", async () => {
    const operator = installOperator({});
    render(<TerminalWindowApp />);
    await screen.findByRole("navigation", { name: "Terminals" });
    const entry = screen.getByRole("button", { name: "Overview" });
    fireEvent.click(entry);
    expect(entry.getAttribute("aria-pressed")).toBe("true");
    const overview = await screen.findByRole("main", { name: "Overview" });
    fireEvent.click(within(overview).getByRole("button", { name: "Rename build" }));
    const field = within(overview).getByRole("textbox", { name: "Terminal name" });
    fireEvent.change(field, { target: { value: "web build" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:rename", { id: "t1", name: "web build" }));
    // Renaming does not open the terminal.
    expect(screen.getByRole("main", { name: "Overview" })).toBeTruthy();
    fireEvent.click(entry);
    expect(screen.queryByRole("main", { name: "Overview" })).toBeNull();
  });

  // Fault detected (Greptile, #3586): Enter or Space in the rename field opened the terminal.
  it("keeps Enter and Space in the rename field for the name", async () => {
    const operator = installOperator({});
    render(<TerminalWindowApp />);
    await screen.findByRole("navigation", { name: "Terminals" });
    operator.command({ command: "overview" });
    const overview = await screen.findByRole("main", { name: "Overview" });
    fireEvent.click(within(overview).getByRole("button", { name: "Rename build" }));
    const field = within(overview).getByRole("textbox", { name: "Terminal name" });
    fireEvent.change(field, { target: { value: "web build" } });
    fireEvent.keyDown(field, { key: " " });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByRole("main", { name: "Overview" })).toBeTruthy();
    expect(within(overview).getByRole("textbox", { name: "Terminal name" })).toBeTruthy();
  });

  // Fault detected (Greptile, #3586): choosing a terminal while the overview was open left it hidden behind the overview.
  it("gives way to a terminal the person chooses or starts", async () => {
    const operator = installOperator({});
    render(<TerminalWindowApp />);
    await screen.findByRole("navigation", { name: "Terminals" });
    operator.command({ command: "overview" });
    await screen.findByRole("main", { name: "Overview" });
    operator.command({ command: "next" });
    await waitFor(() => expect(screen.queryByRole("main", { name: "Overview" })).toBeNull());
    expect(await screen.findByTestId("terminal-view")).toBeTruthy();
    operator.command({ command: "overview" });
    await screen.findByRole("main", { name: "Overview" });
    operator.command({ command: "new-terminal" });
    await waitFor(() => expect(screen.queryByRole("main", { name: "Overview" })).toBeNull());
  });

  // Fault detected (Greptile, #3586): a terminal that finished behind the overview was marked seen unopened.
  it("marks a terminal seen only once the overview gives way to it", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const operator = installOperator({});
    render(<TerminalWindowApp />);
    await screen.findByRole("navigation", { name: "Terminals" });
    operator.command({ command: "overview" });
    fireEvent.click(within(await screen.findByRole("main", { name: "Overview" })).getByRole("button", { name: "Open build" }));
    await screen.findByTestId("terminal-view");
    operator.command({ command: "overview" });
    await screen.findByRole("main", { name: "Overview" });
    const seen = () => operator.invoke.mock.calls.filter(([channel, payload]) => channel === "local-terminal:seen" && (payload as { id: string }).id === "t1");
    const before = seen().length;
    operator.push(operator.facts.map((entry) => (entry.id === "t1" ? { ...entry, status: "done", statusAt: 2_000, turn: 1 } : entry)));
    await waitFor(() => expect(within(screen.getByRole("main", { name: "Overview" })).getByRole("button", { name: "Open build" }).textContent).toMatch(/done/i));
    expect(seen()).toHaveLength(before);
    operator.command({ command: "overview" });
    await waitFor(() => expect(seen()).toHaveLength(before + 1));
  });

  // Fault detected (Greptile, #3586): the overview unmounted the panes, so output a terminal printed
  // before exiting behind it never reached its pane.
  it("covers the panes without unmounting them, and keeps input away from them", async () => {
    const operator = installOperator({});
    render(<TerminalWindowApp />);
    await screen.findByRole("navigation", { name: "Terminals" });
    operator.command({ command: "overview" });
    fireEvent.click(within(await screen.findByRole("main", { name: "Overview" })).getByRole("button", { name: "Open build" }));
    const view = await screen.findByTestId("terminal-view");
    operator.command({ command: "overview" });
    await screen.findByRole("main", { name: "Overview" });
    expect(screen.getByTestId("terminal-view")).toBe(view);
    expect(view.closest("[inert]")).not.toBeNull();
    // Fault detected (Greptile, #3586): typing went nowhere after the overview closed; the covered pane
    // gives up the keyboard and takes it back when uncovered, without reattaching.
    expect(view.dataset.focused).toBe("false");
    operator.command({ command: "overview" });
    await waitFor(() => expect(screen.queryByRole("main", { name: "Overview" })).toBeNull());
    expect(screen.getByTestId("terminal-view")).toBe(view);
    expect(view.closest("[inert]")).toBeNull();
    expect(view.dataset.focused).toBe("true");
  });

  it("keeps a preview's last lines that hold something, cut to width", () => {
    expect(previewLines(`a\n\n${"x".repeat(200)}\n  \n${Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n")}\n`))
      .toEqual(Array.from({ length: 8 }, (_, index) => `line ${index + 2}`));
    expect(previewLines(`${"y".repeat(200)}`)[0]!.length).toBe(160);
  });
});

// Greptile on #3539: a computer's gateway read asks Zellij for its screen and makes it repaint,
// so the overview must not poll idle computer terminals, and nothing is read while hidden.
describe("Terminal window overview previews", () => {
  const WS = `tws_${"a".repeat(32)}`;
  const TAB = `tt_${"b".repeat(32)}`;
  const row = (key: string, statusAt: string, status?: string) => ({ key, name: key, statusAt, status }) as unknown as TerminalSidebarRow;
  const computerKey = `computer:primary|${WS}:${TAB}`;
  let hidden = false;

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installOperator({ t1: "local screen" });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  function setup(failFirst = false, read: () => Promise<{ screen: string }> = async () => ({ screen: "computer screen" })) {
    const get = vi.fn(read);
    if (failFirst) get.mockRejectedValueOnce(new Error("timed out"));
    const client = { get } as unknown as ApiClient;
    const hook = renderHook(
      ({ rows, enabled = true }: { rows: TerminalSidebarRow[]; enabled?: boolean }) => useTerminalPreviews({ rows, enabled, api: () => client }),
      { initialProps: { rows: [row("local|t1", "1"), row(computerKey, "1")] } },
    );
    const localReads = () => window.operator!.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:read").length;
    return { get, hook, localReads };
  }
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("reads an idle computer terminal once, and again only after its status changed and 15 s passed", async () => {
    const { get, hook, localReads } = setup();
    await tick(0);
    expect(get).toHaveBeenCalledTimes(1);
    expect(hook.result.current[computerKey]).toEqual(["computer screen"]);
    await tick(30_000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(localReads()).toBeGreaterThanOrEqual(10);

    hook.rerender({ rows: [row("local|t1", "1"), row(computerKey, "2")] });
    await tick(3_000);
    expect(get).toHaveBeenCalledTimes(2);
    hook.rerender({ rows: [row("local|t1", "1"), row(computerKey, "3")] });
    await tick(3_000);
    expect(get).toHaveBeenCalledTimes(2);
    await tick(COMPUTER_PREVIEW_MIN_MS);
    expect(get).toHaveBeenCalledTimes(3);
  });

  // Fault detected (Greptile, #3586): a terminal joining the list read every idle computer terminal again.
  it("leaves idle computer terminals alone when the list changes", async () => {
    const { get, hook } = setup();
    await tick(0);
    expect(get).toHaveBeenCalledTimes(1);
    hook.rerender({ rows: [row("local|t1", "1"), row(computerKey, "1"), row("local|t2", "1")] });
    await tick(3_000);
    hook.rerender({ rows: [row(computerKey, "1")] });
    await tick(30_000);
    expect(get).toHaveBeenCalledTimes(1);
  });

  // Fault detected (Greptile, #3586): a computer read that failed was never tried again while its status held.
  it("tries a failed computer read again after 15 s", async () => {
    const { get, hook } = setup(true);
    await tick(0);
    expect(get).toHaveBeenCalledTimes(1);
    expect(hook.result.current[computerKey]).toBeUndefined();
    await tick(COMPUTER_PREVIEW_MIN_MS);
    expect(get).toHaveBeenCalledTimes(2);
    expect(hook.result.current[computerKey]).toEqual(["computer screen"]);
    await tick(30_000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  // Fault detected (Greptile, #3586): a computer read that finished after the list changed was dropped,
  // and the terminal was not read again while idle, so its preview stayed blank.
  it("keeps a computer preview that arrives after the list changed", async () => {
    let finish: (value: { screen: string }) => void = () => undefined;
    const { get, hook } = setup(false, () => new Promise((resolve) => { finish = resolve; }));
    await tick(0);
    expect(get).toHaveBeenCalledTimes(1);
    hook.rerender({ rows: [row(computerKey, "1"), row("local|t2", "1")] });
    await tick(0);
    await act(async () => { finish({ screen: "late screen" }); await vi.advanceTimersByTimeAsync(0); });
    await tick(3_000);
    expect(hook.result.current[computerKey]).toEqual(["late screen"]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  // Fault detected (Greptile, #3586): closing and reopening the overview quickly let an older read
  // that finished last replace the newer screen, which then stayed while the terminal was idle.
  it("never lets an older computer read replace a newer screen", async () => {
    const pending: Array<(value: { screen: string }) => void> = [];
    const { hook } = setup(false, () => new Promise((resolve) => { pending.push(resolve); }));
    const rows = [row(computerKey, "1")];
    hook.rerender({ rows });
    await tick(0);
    hook.rerender({ rows, enabled: false });
    hook.rerender({ rows, enabled: true });
    await tick(0);
    expect(pending.length).toBeGreaterThanOrEqual(2);
    await act(async () => { pending.at(-1)!({ screen: "new screen" }); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { pending[0]!({ screen: "old screen" }); await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current[computerKey]).toEqual(["new screen"]);
  });

  // Fault detected (Greptile, #3586): gateway status events carry no time, so a terminal that went
  // from idle to working kept its old preview.
  it("reads a computer terminal again when its status changes without a new time", async () => {
    const { get, hook } = setup();
    await tick(0);
    expect(get).toHaveBeenCalledTimes(1);
    hook.rerender({ rows: [row("local|t1", "1"), row(computerKey, "1", "working")] });
    await tick(COMPUTER_PREVIEW_MIN_MS);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("reads nothing while the window is hidden", async () => {
    hidden = true;
    const { get, localReads } = setup();
    await tick(30_000);
    expect(get).not.toHaveBeenCalled();
    expect(localReads()).toBe(0);
    hidden = false;
    await tick(3_000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(localReads()).toBe(1);
  });
});
