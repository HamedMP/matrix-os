// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName }: { sessionName: string }) => <div data-testid="terminal-view">{sessionName}</div>,
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { createLocalTerminalSocket } from "@desktop/renderer/src/features/terminal-window/local-terminal-socket";

type Listener = (payload: unknown) => void;
function installOperator(local: Record<string, (payload: never) => unknown>) {
  const listeners = new Map<string, Listener[]>();
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "auth:status") return { signedIn: false, platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 0 };
    if (channel === "state:get") return { value: null };
    if (channel === "app:get-zoom") return { factor: 1 };
    const handler = local[channel];
    if (!handler) throw new Error(`unexpected channel ${channel}`);
    return handler(payload as never);
  });
  window.operator = {
    invoke,
    on: (channel, callback) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== callback));
    },
  };
  return { invoke, emit: (channel: string, payload: unknown) => { for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload); },
    listening: (channel: string) => (listeners.get(channel) ?? []).length };
}

describe("This Computer terminals", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("lists local terminals while signed out and opens one", async () => {
    installOperator({ "local-terminal:list": () => ({ status: "ready", terminals: [{ id: "t1", title: "zsh", status: null }, { id: "t2", title: "vim notes", status: null }] }) });
    render(<TerminalWindowApp />);
    const list = await screen.findByRole("list", { name: "This Computer terminals" });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "vim notes" }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t2");
    expect(within(list).getByRole("button", { name: "vim notes" }).getAttribute("aria-current")).toBe("true");
  });

  it("starts a terminal and opens it", async () => {
    const terminals = [] as Array<{ id: string; title: string; status: null }>;
    const operator = installOperator({
      "local-terminal:list": () => ({ status: "ready", terminals: [...terminals] }),
      "local-terminal:create": () => { terminals.push({ id: "t7", title: "Terminal", status: null }); return { status: "ready", id: "t7" }; },
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "New terminal" }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t7");
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:create", { cols: 100, rows: 30 });
  });

  it("ends a terminal, closes its view and refreshes the list", async () => {
    let terminals = [{ id: "t1", title: "zsh", status: null }];
    const operator = installOperator({
      "local-terminal:list": () => ({ status: "ready", terminals }),
      "local-terminal:kill": () => { terminals = []; return { ok: true }; },
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "zsh" }));
    await screen.findByTestId("terminal-view");
    fireEvent.click(screen.getByRole("button", { name: "End zsh" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-view")).toBeNull());
    expect(await screen.findByText("No terminals yet.")).toBeTruthy();
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:kill", { id: "t1" });
  });

  it("shows what each program reported and collects the ones that need the user", async () => {
    installOperator({ "local-terminal:list": () => ({ status: "ready", terminals: [
      { id: "t1", title: "claude", status: "blocked" }, { id: "t2", title: "build", status: "working" },
      { id: "t3", title: "tests", status: "error" }, { id: "t4", title: "shell", status: "idle" }, { id: "t5", title: "plain", status: null },
    ] }) });
    render(<TerminalWindowApp />);
    const attention = await screen.findByRole("region", { name: "Needs attention" });
    expect(within(attention).getAllByRole("button").map((button) => button.textContent)).toEqual(["claudeThis Computer", "testsThis Computer"]);
    const list = screen.getByRole("list", { name: "This Computer terminals" });
    expect(within(list).getByText("Needs you")).toBeTruthy();
    expect(within(list).getByText("Working")).toBeTruthy();
    expect(within(list).getByText("Error")).toBeTruthy();
    expect(within(list).queryByText("idle")).toBeNull();
    fireEvent.click(within(attention).getByRole("button", { name: /claude/ }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t1");
  });

  it("keeps the terminal on screen and says so when ending it did not work", async () => {
    installOperator({
      "local-terminal:list": () => ({ status: "ready", terminals: [{ id: "t1", title: "zsh", status: null }] }),
      "local-terminal:kill": () => ({ ok: false }),
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "zsh" }));
    await screen.findByTestId("terminal-view");
    fireEvent.click(screen.getByRole("button", { name: "End zsh" }));
    expect(await screen.findByText("Couldn't end that terminal. Try again.")).toBeTruthy();
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
    expect(screen.getByRole("button", { name: "zsh" })).toBeTruthy();
  });

  it("keeps the listed terminals when starting another one fails", async () => {
    installOperator({
      "local-terminal:list": () => ({ status: "ready", terminals: [{ id: "t1", title: "zsh", status: null }] }),
      "local-terminal:create": () => ({ status: "unavailable" }),
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "New terminal" }));
    expect(await screen.findByText("Couldn't start a terminal. Try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "zsh" })).toBeTruthy();
    expect(screen.queryByTestId("terminal-view")).toBeNull();
  });

  it("tells a build without local terminals apart from local terminals that failed to start", async () => {
    let listing: unknown = { status: "not-installed" };
    installOperator({ "local-terminal:list": () => listing });
    const first = render(<TerminalWindowApp />);
    expect(await screen.findByText("Local terminals are not included in this build.")).toBeTruthy();
    // Nothing to retry: this build has no runtime to start.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    first.unmount();

    listing = { status: "unavailable" };
    render(<TerminalWindowApp />);
    expect(await screen.findByText("Local terminals couldn't start.")).toBeTruthy();
    listing = { status: "ready", terminals: [] };
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No terminals yet.")).toBeTruthy();
  });

  it("explains a version mismatch and the tab limit without offering what it cannot do", async () => {
    let listing: unknown = { status: "version-mismatch" };
    installOperator({ "local-terminal:list": () => listing, "local-terminal:create": () => ({ status: "limit" }) });
    const second = render(<TerminalWindowApp />);
    expect(await screen.findByText(/started by a different version/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
    second.unmount();

    listing = { status: "ready", terminals: [] };
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "New terminal" }));
    expect(await screen.findByText(/End a terminal to start another/)).toBeTruthy();
    expect(screen.queryByTestId("terminal-view")).toBeNull();
  });
});

describe("local terminal socket", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  const events = () => ({ onState: vi.fn(), onOutput: vi.fn(), onGap: vi.fn(), onExit: vi.fn(), onOwnershipChange: vi.fn() });

  it("attaches at the requested size, relays output in order and forwards input and resize", async () => {
    const operator = installOperator({ "local-terminal:attach": () => ({ ok: true, attachId: 5 }), "local-terminal:ack": () => ({ ok: true }),
      "local-terminal:input": () => ({ ok: true }), "local-terminal:resize": () => ({ ok: true }), "local-terminal:detach": () => ({ ok: true }) });
    const handlers = events();
    const socket = createLocalTerminalSocket("local:t3", handlers);
    socket.resize(132, 43);
    socket.connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:attach", { id: "t3", cols: 132, rows: 43 });

    operator.emit("local-terminal:output", { attachId: 9, data: "someone else" });
    operator.emit("local-terminal:output", { attachId: 5, data: "one" });
    operator.emit("local-terminal:output", { attachId: 5, data: "two" });
    expect(handlers.onOutput.mock.calls).toEqual([["one", 1], ["two", 2]]);
    // One acknowledgement for the burst, counting only this terminal's output.
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:ack", { attachId: 5, count: 2 }));
    expect(operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:ack")).toHaveLength(1);

    socket.sendInput("ls\r");
    socket.sendBinary("\x1b[M");
    socket.resize(80, 24);
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:input", { attachId: 5, data: "ls\r" });
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:input", { attachId: 5, data: "\x1b[M", binary: true });
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:resize", { attachId: 5, cols: 80, rows: 24 });

    socket.detach();
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:detach", { attachId: 5 });
    expect(operator.listening("local-terminal:output")).toBe(0);
    socket.sendInput("ignored");
    expect(operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:input")).toHaveLength(2);
  });

  it("reports ended when the terminal closes or cannot be attached, and releases its listeners", async () => {
    const operator = installOperator({ "local-terminal:attach": () => ({ ok: true, attachId: 2 }), "local-terminal:detach": () => ({ ok: true }) });
    const handlers = events();
    createLocalTerminalSocket("local:t1", handlers).connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    operator.emit("local-terminal:closed", { attachId: 2 });
    expect(handlers.onState).toHaveBeenLastCalledWith("ended");
    expect(operator.listening("local-terminal:closed")).toBe(0);
    expect(operator.invoke).not.toHaveBeenCalledWith("local-terminal:detach", expect.anything());

    const refused = installOperator({ "local-terminal:attach": () => ({ ok: false }) });
    const refusedHandlers = events();
    createLocalTerminalSocket("local:t1", refusedHandlers).connect();
    await waitFor(() => expect(refusedHandlers.onState).toHaveBeenLastCalledWith("ended"));
    expect(refused.listening("local-terminal:output")).toBe(0);
  });

  it("shows the history that arrived before the attach call returned, in order", async () => {
    let resolveAttach!: (value: unknown) => void;
    const operator = installOperator({ "local-terminal:attach": () => new Promise((resolve) => { resolveAttach = resolve; }),
      "local-terminal:ack": () => ({ ok: true }) });
    const handlers = events();
    createLocalTerminalSocket("local:t1", handlers).connect();
    operator.emit("local-terminal:output", { attachId: 4, data: "another terminal" });
    operator.emit("local-terminal:output", { attachId: 6, data: "history " });
    operator.emit("local-terminal:output", { attachId: 6, data: "prompt$ " });
    expect(handlers.onOutput).not.toHaveBeenCalled();
    resolveAttach({ ok: true, attachId: 6 });
    await waitFor(() => expect(handlers.onOutput.mock.calls).toEqual([["history ", 1], ["prompt$ ", 2]]));
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:ack", { attachId: 6, count: 2 }));
  });

  it("stops accepting typing once the trusted core no longer holds the attachment", async () => {
    const operator = installOperator({ "local-terminal:attach": () => ({ ok: true, attachId: 3 }), "local-terminal:input": () => ({ ok: false }),
      "local-terminal:detach": () => ({ ok: true }) });
    const handlers = events();
    const socket = createLocalTerminalSocket("local:t1", handlers);
    socket.connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    socket.sendInput("ls\r");
    await waitFor(() => expect(handlers.onState).toHaveBeenLastCalledWith("ended"));
    socket.sendInput("more");
    expect(operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:input")).toHaveLength(1);
  });

  it("detaches an attachment that completes after the view already left", async () => {
    let resolveAttach!: (value: unknown) => void;
    const operator = installOperator({ "local-terminal:attach": () => new Promise((resolve) => { resolveAttach = resolve; }),
      "local-terminal:detach": () => ({ ok: true }) });
    const handlers = events();
    const socket = createLocalTerminalSocket("local:t1", handlers);
    socket.connect();
    socket.dispose();
    resolveAttach({ ok: true, attachId: 8 });
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:detach", { attachId: 8 }));
    expect(handlers.onState).not.toHaveBeenCalledWith("attached");
  });
});
