// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName }: { sessionName: string }) => <div data-testid="terminal-view">{sessionName}</div>,
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { previewLines } from "@desktop/renderer/src/features/terminal-window/use-terminal-previews";

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
  return { invoke, command: (command: Record<string, unknown>) => act(() => emit("terminal-window:command", command)) };
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

  it("keeps a preview's last lines that hold something, cut to width", () => {
    expect(previewLines(`a\n\n${"x".repeat(200)}\n  \n${Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n")}\n`))
      .toEqual(Array.from({ length: 8 }, (_, index) => `line ${index + 2}`));
    expect(previewLines(`${"y".repeat(200)}`)[0]!.length).toBe(160);
  });
});
