// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { useAppearance } from "@desktop/renderer/src/stores/appearance";

const computers = {
  items: [
    { handle: "operator", runtimeSlot: "primary", label: "Main Computer", availability: "available",
      kind: "customer", gatewayPath: "/vm/operator", capabilities: [] },
    { handle: "operator-review", runtimeSlot: "review", label: "Preview Computer", availability: "starting",
      kind: "preview", gatewayPath: "/vm/operator-review?runtime=review", capabilities: [] },
    { handle: "operator-old", runtimeSlot: "old", label: "Additional Computer", availability: "unavailable",
      kind: "customer", gatewayPath: "/vm/operator-old?runtime=old", capabilities: [] },
  ],
  selectedSlot: "primary",
  hasMore: false,
  limit: 20,
};

type Listener = (payload: unknown) => void;
function installOperator(handlers: Record<string, (payload: unknown) => unknown>) {
  const listeners = new Map<string, Listener[]>();
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`unexpected channel ${channel}`);
    return handler(payload);
  });
  window.operator = {
    invoke,
    on: (channel, callback) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== callback));
    },
  };
  return { invoke, emit: (channel: string, payload: unknown) => { for (const listener of listeners.get(channel) ?? []) listener(payload); } };
}

const signedIn = { signedIn: true, handle: "operator", userId: "user_1", platformHost: "https://app.matrix-os.com",
  runtimeSlot: "primary", authGeneration: 1 };
const base = {
  "app:get-zoom": () => ({ factor: 1 }),
  "app:set-zoom": () => ({ ok: true }),
  "state:get": () => ({ value: null }),
  "local-terminal:watch": () => ({ status: "ready", terminals: [] }),
};

// Every available computer gets an events stream; none may reach the network in a test.
class FakeWebSocket {
  static opened: string[] = [];
  readyState = 0;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  constructor(readonly url: string) { FakeWebSocket.opened.push(url); }
  send() { /* no server */ }
  close() { this.readyState = 3; }
}

describe("Terminal window", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    FakeWebSocket.opened = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("lists this device first, then every Matrix computer with its availability, streaming status only from available ones", async () => {
    installOperator({ ...base, "auth:status": () => signedIn, "runtime:list-computers": () => computers });
    render(<TerminalWindowApp />);
    expect(await screen.findByText("operator")).toBeTruthy();
    // Each machine is a space of its own (no home or main rows under it).
    const machines = Array.from(document.querySelectorAll('ul[aria-label="Machines"] > li[data-space]'));
    expect(machines.map((item) => item.getAttribute("data-space"))).toEqual(["local", "computer:primary", "computer:review"]);
    expect(FakeWebSocket.opened).toEqual(["wss://app.matrix-os.com/ws/terminal/events"]);
    // Each computer leads with its own name; unavailable ones wait under one fold.
    expect(screen.getByText("Preview Computer · Starting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unavailable (1)" }));
    expect(screen.getByText("operator-old · Additional Computer · Unavailable")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Terminals across your computers" })).toBeTruthy();
  });

  it("uses the owner's saved theme, reading only the appearance key", async () => {
    const operator = installOperator({ ...base, "auth:status": () => ({ ...signedIn, signedIn: false }),
      "state:get": () => ({ value: { theme: "dark" } }) });
    render(<TerminalWindowApp />);
    await waitFor(() => expect(useAppearance.getState().mode).toBe("dark"));
    const reads = operator.invoke.mock.calls.filter(([channel]) => channel === "state:get");
    expect(reads).toEqual([["state:get", { key: "appearance" }]]);
  });

  it("shows a sign-in empty state that hands off to the main window while This Computer stays listed", async () => {
    const operator = installOperator({ ...base, "auth:status": () => ({ signedIn: false, platformHost: "https://app.matrix-os.com", authGeneration: 0 }),
      "terminal-window:focus-main": () => ({ ok: true }) });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(operator.invoke).toHaveBeenCalledWith("terminal-window:focus-main", {});
    expect(within(screen.getByRole("list", { name: "Machines" })).getByText("This Computer")).toBeTruthy();
    // Fault detected (Greptile, #3567): Settings only raised the main window, wherever it was.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(operator.invoke).toHaveBeenCalledWith("terminal-window:focus-main", { to: "settings" });
    expect(operator.invoke).not.toHaveBeenCalledWith("runtime:list-computers", {});
  });

  it("shows a generic retry state when the inventory fails and recovers on retry", async () => {
    let fail = true;
    installOperator({ ...base, "auth:status": () => signedIn,
      "runtime:list-computers": () => { if (fail) throw new Error("ECONNREFUSED 10.0.0.4:443 token=abc"); return computers; } });
    render(<TerminalWindowApp />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Couldn't load your computers.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText("operator")).toBeTruthy();
  });

  it("reloads the inventory when the session changes and ignores a stale response", async () => {
    let resolveFirst!: (value: unknown) => void;
    let calls = 0;
    const operator = installOperator({ ...base, "auth:status": () => signedIn,
      "runtime:list-computers": () => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        return { ...computers, items: [computers.items[1]], selectedSlot: "review" };
      } });
    render(<TerminalWindowApp />);
    await waitFor(() => expect(calls).toBe(1));
    act(() => operator.emit("auth:changed", { signedIn: true, handle: "operator" }));
    expect(await screen.findByText("operator-review")).toBeTruthy();
    await act(async () => { resolveFirst(computers); });
    expect(screen.queryByText("operator")).toBeNull();
  });

  it("lets a computer that finished starting be opened without reopening the window", async () => {
    let inventory = { ...computers, items: computers.items.map((item, index) => (index === 0 ? { ...item, availability: "starting" } : item)) };
    const operator = installOperator({ ...base, "auth:status": () => signedIn, "runtime:list-computers": () => inventory });
    render(<TerminalWindowApp />);
    const name = computers.items[0]!.handle;
    await screen.findByText(name);
    // While it starts it cannot be chosen, has no +, and no events stream.
    const machine = () => document.querySelector<HTMLButtonElement>(`li[data-space="computer:primary"] button[aria-pressed]`)!;
    expect(machine().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: `New terminal on ${name}` })).toBeNull();
    expect(FakeWebSocket.opened).toEqual([]);
    inventory = computers;
    act(() => operator.emit("window:focus-changed", { focused: true }));
    await waitFor(() => expect(machine().disabled).toBe(false));
    await waitFor(() => expect(FakeWebSocket.opened).toEqual(["wss://app.matrix-os.com/ws/terminal/events"]));
    expect(screen.getByRole("button", { name: `New terminal on ${name}` })).toBeTruthy();
    // The refresh never flashed the loading state over the list.
    expect(screen.queryByText("Loading your computers…")).toBeNull();
  });

  it("keeps the listed computers when a background refresh fails", async () => {
    let fail = false;
    const operator = installOperator({ ...base, "auth:status": () => signedIn,
      "runtime:list-computers": () => { if (fail) throw new Error("offline"); return computers; } });
    render(<TerminalWindowApp />);
    await screen.findByText(computers.items[0]!.handle);
    fail = true;
    act(() => operator.emit("window:focus-changed", { focused: true }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText(computers.items[0]!.handle)).toBeTruthy();
    expect(screen.queryByText("Couldn't load your computers.")).toBeNull();
  });

  it("clears computers on sign-out", async () => {
    let status: unknown = signedIn;
    const operator = installOperator({ ...base, "auth:status": () => status, "runtime:list-computers": () => computers });
    render(<TerminalWindowApp />);
    expect(await screen.findByText("operator")).toBeTruthy();
    status = { signedIn: false, platformHost: "https://app.matrix-os.com", authGeneration: 2 };
    act(() => operator.emit("auth:changed", { signedIn: false }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("operator")).toBeNull();
  });
});
