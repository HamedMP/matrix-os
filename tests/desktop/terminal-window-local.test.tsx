// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Records each mount of a terminal view, for tests that care about remounting.
let mountLog: string[] | null = null;
vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: function TerminalViewStub({ sessionName }: { sessionName: string }) {
    React.useEffect(() => { mountLog?.push(sessionName); }, [sessionName]);
    return <div data-testid="terminal-view">{sessionName}</div>;
  },
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { createLocalTerminalSocket, inputChunkEnd } from "@desktop/renderer/src/features/terminal-window/local-terminal-socket";

type Listener = (payload: unknown) => void;
function installOperator(local: Record<string, (payload: never) => unknown>) {
  const listeners = new Map<string, Listener[]>();
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "auth:status" && !local[channel]) return { signedIn: false, platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 0 };
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
    fireEvent.pointerDown(await screen.findByRole("button", { name: "New terminal" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Shell" }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t7");
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:create", { cols: 100, rows: 30 });
  });

  it("does not take the pane from a terminal the user opened while a new one was starting", async () => {
    const terminals = [{ id: "t1", title: "zsh", status: null }];
    let finishCreate!: (value: unknown) => void;
    installOperator({
      "local-terminal:list": () => ({ status: "ready", terminals: [...terminals] }),
      "local-terminal:create": () => new Promise((resolve) => { finishCreate = resolve; }),
    });
    render(<TerminalWindowApp />);
    fireEvent.pointerDown(await screen.findByRole("button", { name: "New terminal" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Shell" }));
    await waitFor(() => expect(finishCreate).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "zsh" }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t1");
    terminals.push({ id: "t2", title: "Terminal", status: null });
    await act(async () => { finishCreate({ status: "ready", id: "t2" }); });
    // The new terminal is listed, but the one the user chose stays open.
    expect(await screen.findByRole("button", { name: "Terminal" })).toBeTruthy();
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
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
    expect(within(list).getAllByText("Needs you")).toHaveLength(2);
    expect(within(list).getByText("Working")).toBeTruthy();
    expect(within(list).queryByText("idle")).toBeNull();
    fireEvent.click(within(attention).getByRole("button", { name: /claude/ }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t1");
  });

  it("lists more terminals than any fixed ceiling", async () => {
    const terminals = Array.from({ length: 60 }, (_, index) => ({ id: `t${index + 1}`, title: `shell ${index + 1}`, status: null }));
    installOperator({ "local-terminal:list": () => ({ status: "ready", terminals }) });
    render(<TerminalWindowApp />);
    const list = await screen.findByRole("list", { name: "This Computer terminals" });
    expect(within(list).getByRole("button", { name: "shell 60" })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "New terminal" })).toBeTruthy();
  });

  it("keeps the pane of a shell that exited, marked ended, until the user closes it", async () => {
    let terminals = [{ id: "t1", title: "build", status: null }];
    installOperator({ "local-terminal:list": () => ({ status: "ready", terminals }) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<TerminalWindowApp />);
      fireEvent.click(await screen.findByRole("button", { name: "build" }));
      await screen.findByTestId("terminal-view");
      // The program exits: the next listing no longer has it.
      terminals = [];
      await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
      const list = screen.getByRole("list", { name: "This Computer terminals" });
      await waitFor(() => expect(within(list).getByText("ended")).toBeTruthy());
      expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
      expect(screen.queryByText("No terminals yet.")).toBeNull();
      fireEvent.click(within(list).getByRole("button", { name: "Close build" }));
      expect(screen.queryByTestId("terminal-view")).toBeNull();
      expect(await screen.findByText("No terminals yet.")).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("reattaches the open local terminal after a sign-in change resets attachments", async () => {
    let status: unknown = { signedIn: false, platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 0 };
    const mounts: string[] = [];
    mountLog = mounts;
    const operator = installOperator({
      "auth:status": () => status,
      "runtime:list-computers": () => ({
        items: [{ handle: "neo", runtimeSlot: "primary", label: "Main Computer", availability: "available", kind: "customer", gatewayPath: "/vm/neo", capabilities: [] }],
        selectedSlot: "primary", hasMore: false, limit: 20,
      }),
      "local-terminal:list": () => ({ status: "ready", terminals: [{ id: "t1", title: "zsh", status: null }] }),
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "zsh" }));
    await screen.findByTestId("terminal-view");
    const before = mounts.length;
    status = { signedIn: true, handle: "neo", userId: "user_1", platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 1 };
    act(() => operator.emit("auth:changed", { signedIn: true, handle: "neo" }));
    // The same terminal stays open, in a pane mounted afresh so it attaches again.
    await waitFor(() => expect(mounts.length).toBeGreaterThan(before));
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
    mountLog = null;
  });

  it("keeps a local terminal open when a cloud terminal finishes being created afterwards", async () => {
    const WS = `tws_${"a".repeat(32)}`;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let finishCreate!: (response: Response) => void;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/ensure")) return json({ workspace: { id: WS } });
      if (init?.method === "POST") return new Promise<Response>((resolve) => { finishCreate = resolve; });
      return json({ workspaces: [{ id: WS, scope: "main", tabs: [] }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounts: string[] = [];
    mountLog = mounts;
    try {
      installOperator({
        "auth:status": () => ({ signedIn: true, handle: "neo", userId: "user_1", platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 1 }),
        "runtime:list-computers": () => ({
          items: [{ handle: "neo", runtimeSlot: "primary", label: "Main Computer", availability: "available", kind: "customer", gatewayPath: "/vm/neo", capabilities: [] }],
          selectedSlot: "primary", hasMore: false, limit: 20,
        }),
        "local-terminal:list": () => ({ status: "ready", terminals: [{ id: "t1", title: "zsh", status: null }] }),
      });
      render(<TerminalWindowApp />);
      fireEvent.click(await screen.findByRole("button", { name: /Main Computer/ }));
      const cloud = await screen.findByRole("list", { name: "Main Computer terminals" });
      fireEvent.click(within(cloud).getByRole("button", { name: "New terminal" }));
      await waitFor(() => expect(finishCreate).toBeTypeOf("function"));
      // While the computer is still creating it, the user opens a local terminal.
      fireEvent.click(screen.getByRole("button", { name: "zsh" }));
      expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t1");
      const mounted = mounts.length;
      await act(async () => { finishCreate(json({ tab: { id: `tt_${"2".repeat(32)}`, name: "Terminal" } }, 201)); });
      await waitFor(() => expect(within(cloud).getByRole("button", { name: "New terminal" }).hasAttribute("disabled")).toBe(false));
      // Still the local terminal, and its pane was not torn down underneath it.
      expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
      expect(mounts.length).toBe(mounted);
    } finally { mountLog = null; vi.unstubAllGlobals(); }
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
    fireEvent.pointerDown(await screen.findByRole("button", { name: "New terminal" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Shell" }));
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

  it("explains a version mismatch and a too-fast start without offering what it cannot do", async () => {
    let listing: unknown = { status: "version-mismatch" };
    installOperator({ "local-terminal:list": () => listing, "local-terminal:create": () => ({ status: "rate-limited" }) });
    const second = render(<TerminalWindowApp />);
    expect(await screen.findByText(/started by a different version/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
    second.unmount();

    listing = { status: "ready", terminals: [] };
    render(<TerminalWindowApp />);
    fireEvent.pointerDown(await screen.findByRole("button", { name: "New terminal" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Shell" }));
    expect(await screen.findByText("Too many terminals started at once. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByTestId("terminal-view")).toBeNull();
  });
});

describe("This Computer agents and names", () => {
  // Fault detected: Electron Desktop cannot start a coding agent or name a terminal,
  // unlike Web Desktop and Herdr's own + menu.
  it("starts a chosen agent and renames a terminal", async () => {
    const terminals = [{ id: "t1", title: "zsh", status: null }];
    const operator = installOperator({
      "local-terminal:list": () => ({ status: "ready", terminals: [...terminals] }),
      "local-terminal:create": () => { terminals.push({ id: "t9", title: "claude", status: "working" }); return { status: "ready", id: "t9" }; },
      "local-terminal:rename": () => { terminals[0] = { ...terminals[0]!, title: "review" }; return { ok: true }; },
    });
    render(<TerminalWindowApp />);
    fireEvent.pointerDown(await screen.findByRole("button", { name: "New terminal" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t9");
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:create", { cols: 100, rows: 30, agent: "claude" });

    fireEvent.click(screen.getByRole("button", { name: "Rename zsh" }));
    const input = screen.getByRole("textbox", { name: "Terminal name" });
    fireEvent.change(input, { target: { value: "review" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "review" })).toBeTruthy();
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:rename", { id: "t1", name: "review" });
    expect(operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:rename")).toHaveLength(1);
  });

  // Fault detected (review of #3300): the open pane kept the old name after a rename.
  it("keeps the new name on the open terminal after it ends", async () => {
    let terminals = [{ id: "t1", title: "zsh", status: null as null }];
    installOperator({
      "local-terminal:list": () => ({ status: "ready", terminals: [...terminals] }),
      "local-terminal:rename": () => { terminals = [{ ...terminals[0]!, title: "review" }]; return { ok: true }; },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<TerminalWindowApp />);
      fireEvent.click(await screen.findByRole("button", { name: "zsh" }));
      fireEvent.click(screen.getByRole("button", { name: "Rename zsh" }));
      const input = screen.getByRole("textbox", { name: "Terminal name" });
      fireEvent.change(input, { target: { value: "review" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByRole("button", { name: "review" })).toBeTruthy();
      // The program exits: the next listing no longer has it.
      terminals = [];
      await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
      const list = screen.getByRole("list", { name: "This Computer terminals" });
      await waitFor(() => expect(within(list).getByText("ended")).toBeTruthy());
      expect(within(list).getByText("review")).toBeTruthy();
      expect(within(list).queryByText("zsh")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});

describe("local terminal socket", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  // The view draws output and then says so, as xterm's write callback does.
  const events = () => ({ onState: vi.fn(), onOutput: vi.fn((_data: string, _seq: number, written?: () => void) => { written?.(); }),
    onGap: vi.fn(), onExit: vi.fn(), onOwnershipChange: vi.fn() });

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
    expect(handlers.onOutput.mock.calls.map(([data, seq]) => [data, seq])).toEqual([["one", 1], ["two", 2]]);
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
    await waitFor(() => expect(handlers.onOutput.mock.calls.map(([data, seq]) => [data, seq])).toEqual([["history ", 1], ["prompt$ ", 2]]));
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:ack", { attachId: 6, count: 2 }));
  });

  it("returns output credit only after the view has drawn the output", async () => {
    const operator = installOperator({ "local-terminal:attach": () => ({ ok: true, attachId: 7 }), "local-terminal:ack": () => ({ ok: true }) });
    const drawn: Array<() => void> = [];
    const handlers = { ...events(), onOutput: vi.fn((_data: string, _seq: number, written?: () => void) => { if (written) drawn.push(written); }) };
    createLocalTerminalSocket("local:t1", handlers).connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    operator.emit("local-terminal:output", { attachId: 7, data: "a flood of output" });
    await Promise.resolve();
    await Promise.resolve();
    const acks = () => operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:ack");
    expect(acks()).toEqual([]);
    drawn[0]!();
    drawn[0]!();
    await waitFor(() => expect(acks()).toEqual([["local-terminal:ack", { attachId: 7, count: 1 }]]));
  });

  it("splits a very large burst of acknowledgements instead of losing it", async () => {
    const operator = installOperator({ "local-terminal:attach": () => ({ ok: true, attachId: 7 }), "local-terminal:ack": () => ({ ok: true }) });
    const handlers = events();
    createLocalTerminalSocket("local:t1", handlers).connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    // A hidden window draws thousands of queued chunks in one slice.
    for (let index = 0; index < 5_000; index += 1) operator.emit("local-terminal:output", { attachId: 7, data: "x" });
    const acks = () => operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:ack").map(([, payload]) => (payload as { count: number }).count);
    await waitFor(() => expect(acks().reduce((sum, count) => sum + count, 0)).toBe(5_000));
    expect(Math.max(...acks())).toBeLessThanOrEqual(4_096);
  });

  it("acknowledges output on arrival while the window is hidden, so a background program is not slowed", async () => {
    const operator = installOperator({ "local-terminal:attach": () => ({ ok: true, attachId: 7 }), "local-terminal:ack": () => ({ ok: true }) });
    // The view never reports drawing: a throttled, hidden page.
    const handlers = { ...events(), onOutput: vi.fn() };
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    createLocalTerminalSocket("local:t1", handlers).connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    operator.emit("local-terminal:output", { attachId: 7, data: "build output" });
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:ack", { attachId: 7, count: 1 }));
    expect(handlers.onOutput).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it("returns credit for early output it had no room to keep", async () => {
    let resolveAttach!: (value: unknown) => void;
    const operator = installOperator({ "local-terminal:attach": () => new Promise((resolve) => { resolveAttach = resolve; }),
      "local-terminal:ack": () => ({ ok: true }) });
    const handlers = events();
    createLocalTerminalSocket("local:t1", handlers).connect();
    for (let index = 0; index < 300; index += 1) operator.emit("local-terminal:output", { attachId: 6, data: "h" });
    resolveAttach({ ok: true, attachId: 6 });
    const acked = () => operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:ack")
      .reduce((sum, [, payload]) => sum + (payload as { count: number }).count, 0);
    await waitFor(() => expect(acked()).toBe(300));
    expect(handlers.onOutput).toHaveBeenCalledTimes(256);
  });

  it("never cuts a pasted character in half when splitting long input", async () => {
    const emoji = "\u{1F600}";
    const text = `${"a".repeat(32_767)}${emoji}${"b".repeat(10)}`;
    expect(inputChunkEnd(text, 0)).toBe(32_767);
    expect(inputChunkEnd(text, 32_767)).toBe(text.length);
    expect(inputChunkEnd("short", 0)).toBe(5);

    const operator = installOperator({ "local-terminal:attach": () => ({ ok: true, attachId: 3 }), "local-terminal:input": () => ({ ok: true }) });
    const handlers = events();
    const socket = createLocalTerminalSocket("local:t1", handlers);
    socket.connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    socket.sendInput(text);
    const sent = operator.invoke.mock.calls.filter(([channel]) => channel === "local-terminal:input").map(([, payload]) => (payload as { data: string }).data);
    expect(sent.join("")).toBe(text);
    // Each piece is well-formed on its own, so encoding it cannot corrupt the character.
    for (const piece of sent) expect(piece.isWellFormed()).toBe(true);
    expect(sent).toHaveLength(2);
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

  it("shows a shell that ended while it was attaching as ended, after its last output", async () => {
    let resolveAttach!: (value: unknown) => void;
    const operator = installOperator({ "local-terminal:attach": () => new Promise((resolve) => { resolveAttach = resolve; }),
      "local-terminal:ack": () => ({ ok: true }) });
    const handlers = events();
    createLocalTerminalSocket("local:t1", handlers).connect();
    operator.emit("local-terminal:output", { attachId: 6, data: "exit\r\n" });
    operator.emit("local-terminal:closed", { attachId: 6 });
    operator.emit("local-terminal:closed", { attachId: 9 });
    resolveAttach({ ok: true, attachId: 6 });
    await waitFor(() => expect(handlers.onState).toHaveBeenLastCalledWith("ended"));
    expect(handlers.onOutput.mock.calls.map(([data]) => data)).toEqual(["exit\r\n"]);
    // Nothing is left to detach, and typing goes nowhere.
    expect(operator.invoke).not.toHaveBeenCalledWith("local-terminal:detach", expect.anything());
    expect(operator.listening("local-terminal:closed")).toBe(0);
  });

  it("sends the pane's size to the shell when it was resized while attaching", async () => {
    let resolveAttach!: (value: unknown) => void;
    const operator = installOperator({ "local-terminal:attach": () => new Promise((resolve) => { resolveAttach = resolve; }),
      "local-terminal:resize": () => ({ ok: true }) });
    const handlers = events();
    const socket = createLocalTerminalSocket("local:t1", handlers);
    socket.resize(100, 30);
    socket.connect();
    socket.resize(140, 50);
    expect(operator.invoke).not.toHaveBeenCalledWith("local-terminal:resize", expect.anything());
    resolveAttach({ ok: true, attachId: 4 });
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:resize", { attachId: 4, cols: 140, rows: 50 }));
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:attach", { id: "t1", cols: 100, rows: 30 });
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
