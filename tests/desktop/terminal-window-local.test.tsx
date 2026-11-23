// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Records each mount of a terminal view, for tests that care about remounting.
let mountLog: string[] | null = null;
vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: function TerminalViewStub({ sessionName, findRequest }: { sessionName: string; findRequest?: number }) {
    React.useEffect(() => { mountLog?.push(sessionName); }, [sessionName]);
    return <div data-testid="terminal-view" data-find={findRequest ?? 0}>{sessionName}</div>;
  },
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { createLocalTerminalSocket, inputChunkEnd } from "@desktop/renderer/src/features/terminal-window/local-terminal-socket";

beforeAll(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

type Listener = (payload: unknown) => void;
function installOperator(local: Record<string, (payload: never) => unknown>) {
  const listeners = new Map<string, Listener[]>();
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "auth:status" && !local[channel]) return { signedIn: false, platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 0 };
    if (channel === "state:get") return { value: null };
    if (channel === "app:get-zoom") return { factor: 1 };
    if (channel === "local-terminal:seen" && !local[channel]) return { ok: true };
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
  const emit = (channel: string, payload: unknown) => { for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload); };
  return { invoke, emit, listening: (channel: string) => (listeners.get(channel) ?? []).length,
    /** The trusted core pushes new facts, as herdr-core's events change. */
    push: (terminals: unknown[]) => act(() => emit("local-terminal:facts", { terminals })),
    command: (command: Record<string, unknown>) => act(() => emit("terminal-window:command", command)) };
}

type Fact = { id: string; title: string; status: string | null; statusAt: number | null; turn: number; seenTurn: number | null; finished: boolean; finishedSeen?: boolean; agent?: string };
const fact = (id: string, title: string, extra: Partial<Fact> = {}): Fact => ({
  id, title, status: null, statusAt: 1_000, turn: 0, seenTurn: null, finished: false, ...extra,
});
const watching = (terminals: Fact[] | (() => Fact[])) => () => ({ status: "ready", terminals: typeof terminals === "function" ? terminals() : terminals });
const sidebar = () => screen.getByRole("navigation", { name: "Terminals" });
const row = (name: string | RegExp) => within(sidebar()).getByRole("button", { name });
const findRow = async (name: string | RegExp) => within(await screen.findByRole("navigation", { name: "Terminals" })).findByRole("button", { name });

async function startShell(agent = "Shell") {
  fireEvent.pointerDown(await screen.findByRole("button", { name: "New terminal" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: agent }));
}

describe("This Computer terminals", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); window.localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("lists local terminals while signed out, opens one and marks it seen", async () => {
    const operator = installOperator({ "local-terminal:watch": watching([fact("t1", "zsh"), fact("t2", "vim notes", { status: "done", turn: 2 })]) });
    render(<TerminalWindowApp />);
    fireEvent.click(await findRow(/vim notes/));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t2");
    expect(row(/vim notes/).getAttribute("aria-current")).toBe("true");
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:seen", { id: "t2" });
    // Status comes from pushed facts; nothing lists on a timer.
    expect(operator.invoke.mock.calls.some(([channel]) => channel === "local-terminal:list")).toBe(false);
  });

  it("starts a terminal and opens it", async () => {
    const terminals: Fact[] = [];
    const operator = installOperator({
      "local-terminal:watch": watching(() => terminals),
      "local-terminal:create": () => { terminals.push(fact("t7", "Terminal")); return { status: "ready", id: "t7" }; },
    });
    render(<TerminalWindowApp />);
    await startShell();
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t7");
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:create", { cols: 100, rows: 30 });
  });

  it("does not take the pane from a terminal the user opened while a new one was starting", async () => {
    let finishCreate!: (value: unknown) => void;
    installOperator({
      "local-terminal:watch": watching([fact("t1", "zsh")]),
      "local-terminal:create": () => new Promise((resolve) => { finishCreate = resolve; }),
    });
    render(<TerminalWindowApp />);
    await startShell();
    await waitFor(() => expect(finishCreate).toBeTypeOf("function"));
    fireEvent.click(row(/zsh/));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t1");
    await act(async () => { finishCreate({ status: "ready", id: "t2" }); });
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
  });

  it("asks before Cmd+W ends a running terminal, then closes its view", async () => {
    const operator = installOperator({
      "local-terminal:watch": watching([fact("t1", "zsh", { status: "working" })]),
      "local-terminal:kill": () => ({ ok: true }),
      "local-terminal:remove": () => ({ ok: true }),
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await findRow(/zsh/));
    await screen.findByTestId("terminal-view");
    operator.command({ command: "close-terminal" });
    // ENG-521: the app's destructive confirm, naming the terminal; the last pane says "End terminal".
    const dialog = await screen.findByRole("alertdialog", { name: "End “zsh”?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(within(dialog).getByText("↵ End")).toBeTruthy();
    expect(operator.invoke).not.toHaveBeenCalledWith("local-terminal:kill", expect.anything());
    fireEvent.click(within(dialog).getByRole("button", { name: "End terminal" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-view")).toBeNull());
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:kill", { id: "t1" });
    // Closing the pane takes the ended terminal off the list too.
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:remove", { id: "t1" });
    operator.push([]);
    expect(await screen.findByText(/No terminals yet/)).toBeTruthy();
  });

  it("removes a finished terminal with Cmd+W without asking", async () => {
    const operator = installOperator({
      "local-terminal:watch": watching([fact("t3", "tests", { finished: true, finishedSeen: true })]),
      "local-terminal:remove": () => ({ ok: true }),
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await findRow(/tests/));
    operator.command({ command: "close-terminal" });
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:remove", { id: "t3" }));
    expect(screen.queryByRole("alertdialog", { name: /^End “/ })).toBeNull();
  });

  it("files terminals by what they need: Needs you, Done, Working, Idle", async () => {
    installOperator({ "local-terminal:watch": watching([
      fact("t1", "claude", { status: "blocked" }), fact("t2", "build", { status: "working" }),
      fact("t3", "tests", { status: "error" }), fact("t4", "shell", { status: "idle" }), fact("t5", "plain"),
      fact("t6", "finished", { finished: true }),
    ]) });
    render(<TerminalWindowApp />);
    const needsYou = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needsYou).getAllByRole("button").filter((button) => !/^(Pin terminal|Unpin terminal|Close terminal|Open in a tab)$/.test(button.getAttribute("aria-label") ?? ""))
      .map((button) => button.textContent?.replace(/Needs you|Error|<1m|\d+[mhd]/g, "").trim()))
      .toEqual(expect.arrayContaining(["claude", "tests"]));
    expect(within(screen.getByRole("region", { name: "Done" })).getByRole("button", { name: /finished/ })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Working" })).getByRole("button", { name: /build/ })).toBeTruthy();
    // Each row's pin and close actions are left out: they are not rows.
    const rowButtons = (region: HTMLElement) => within(region).getAllByRole("button")
      .filter((button) => !/^(Pin terminal|Unpin terminal|Close terminal|Open in a tab)$/.test(button.getAttribute("aria-label") ?? ""));
    expect(rowButtons(screen.getByRole("region", { name: "Idle" })).map((button) => button.textContent))
      .toEqual(["Idle2", expect.stringContaining("shell"), expect.stringContaining("plain")]);
    fireEvent.click(within(needsYou).getByRole("button", { name: /claude/ }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t1");
  });

  it("lists more terminals than any fixed ceiling", async () => {
    installOperator({ "local-terminal:watch": watching(Array.from({ length: 60 }, (_, index) => fact(`t${index + 1}`, `shell ${index + 1}`))) });
    render(<TerminalWindowApp />);
    expect(await findRow(/shell 60/)).toBeTruthy();
  });

  it("keeps the pane of a shell that exited, marked ended, until the user closes it", async () => {
    const operator = installOperator({ "local-terminal:watch": watching([fact("t1", "build")]) });
    render(<TerminalWindowApp />);
    fireEvent.click(await findRow(/build/));
    await screen.findByTestId("terminal-view");
    operator.push([fact("t1", "build", { finished: true })]);
    expect(await screen.findByText("build ended")).toBeTruthy();
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
    fireEvent.click(screen.getByRole("button", { name: "Close build" }));
    expect(screen.queryByTestId("terminal-view")).toBeNull();
  });

  // Fault detected (Greptile, #3567): a running terminal on an added machine read as ended.
  it("keeps a running terminal on an added machine live", async () => {
    installOperator({ "local-terminal:watch": watching([fact("vps/t4", "deploy")]) });
    render(<TerminalWindowApp />);
    fireEvent.click(await findRow(/deploy/));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:vps/t4");
    expect(screen.queryByText("deploy ended")).toBeNull();
  });

  it("reattaches the open local terminal after a sign-in change resets attachments", async () => {
    let status: unknown = { signedIn: false, platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 0 };
    const mounts: string[] = [];
    mountLog = mounts;
    vi.stubGlobal("WebSocket", class { readyState = 0; send() { /* none */ } close() { /* none */ } });
    const operator = installOperator({
      "auth:status": () => status,
      "runtime:list-computers": () => ({
        items: [{ handle: "neo", runtimeSlot: "primary", label: "Main Computer", availability: "available", kind: "customer", gatewayPath: "/vm/neo", capabilities: [] }],
        selectedSlot: "primary", hasMore: false, limit: 20,
      }),
      "local-terminal:watch": watching([fact("t1", "zsh")]),
    });
    try {
      render(<TerminalWindowApp />);
      fireEvent.click(await findRow(/zsh/));
      await screen.findByTestId("terminal-view");
      const before = mounts.length;
      status = { signedIn: true, handle: "neo", userId: "user_1", platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 1 };
      act(() => operator.emit("auth:changed", { signedIn: true, handle: "neo" }));
      await waitFor(() => expect(mounts.length).toBeGreaterThan(before));
      expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
    } finally { mountLog = null; vi.unstubAllGlobals(); }
  });

  it("keeps a local terminal open when a cloud terminal finishes being created afterwards", async () => {
    const WS = `tws_${"a".repeat(32)}`;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let finishCreate!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/ensure")) return json({ workspace: { id: WS } });
      if (init?.method === "POST") return new Promise<Response>((resolve) => { finishCreate = resolve; });
      return json({ workspaces: [{ id: WS, scope: "main", tabs: [] }] });
    }));
    vi.stubGlobal("WebSocket", class { readyState = 0; send() { /* none */ } close() { /* none */ } });
    const mounts: string[] = [];
    mountLog = mounts;
    try {
      installOperator({
        "auth:status": () => ({ signedIn: true, handle: "neo", userId: "user_1", platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 1 }),
        "runtime:list-computers": () => ({
          items: [{ handle: "neo", runtimeSlot: "primary", label: "Main Computer", availability: "available", kind: "customer", gatewayPath: "/vm/neo", capabilities: [] }],
          selectedSlot: "primary", hasMore: false, limit: 20,
        }),
        "local-terminal:watch": watching([fact("t1", "zsh")]),
      });
      render(<TerminalWindowApp />);
      const create = await screen.findByRole("button", { name: "New terminal on neo" });
      fireEvent.click(create);
      await waitFor(() => expect(finishCreate).toBeTypeOf("function"));
      fireEvent.click(row(/zsh/));
      expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t1");
      const mounted = mounts.length;
      await act(async () => { finishCreate(json({ tab: { id: `tt_${"2".repeat(32)}`, name: "Terminal" } }, 201)); });
      await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
      expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
      expect(mounts.length).toBe(mounted);
    } finally { mountLog = null; vi.unstubAllGlobals(); }
  });

  it("keeps the terminal on screen and says so when ending it did not work", async () => {
    const operator = installOperator({
      "local-terminal:watch": watching([fact("t1", "zsh", { status: "working" })]),
      "local-terminal:kill": () => ({ ok: false }),
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await findRow(/zsh/));
    await screen.findByTestId("terminal-view");
    operator.command({ command: "close-terminal" });
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: /^End “/ })).getByRole("button", { name: "End terminal" }));
    expect(await screen.findByText("Couldn't end that terminal. Try again.")).toBeTruthy();
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1");
  });

  it("keeps the listed terminals when starting another one fails", async () => {
    installOperator({ "local-terminal:watch": watching([fact("t1", "zsh")]), "local-terminal:create": () => ({ status: "unavailable" }) });
    render(<TerminalWindowApp />);
    await startShell();
    expect(await screen.findByText("Couldn't start a terminal. Try again.")).toBeTruthy();
    expect(row(/zsh/)).toBeTruthy();
    expect(screen.queryByTestId("terminal-view")).toBeNull();
  });

  it("tells a build without local terminals apart from local terminals that failed to start", async () => {
    let listing: unknown = { status: "not-installed" };
    installOperator({ "local-terminal:watch": () => listing });
    const first = render(<TerminalWindowApp />);
    expect(await screen.findByText("Local terminals are not included in this build.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    first.unmount();

    listing = { status: "unavailable" };
    render(<TerminalWindowApp />);
    expect(await screen.findByText("Local terminals couldn't start.")).toBeTruthy();
    listing = { status: "ready", terminals: [] };
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No terminals yet/)).toBeTruthy();
  });

  it("explains a version mismatch and a too-fast start without offering what it cannot do", async () => {
    let listing: unknown = { status: "version-mismatch" };
    installOperator({ "local-terminal:watch": () => listing, "local-terminal:create": () => ({ status: "rate-limited" }) });
    const second = render(<TerminalWindowApp />);
    expect(await screen.findByText(/started by a different version/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
    second.unmount();

    listing = { status: "ready", terminals: [] };
    render(<TerminalWindowApp />);
    await startShell();
    expect(await screen.findByText("Too many terminals started at once. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByTestId("terminal-view")).toBeNull();
  });
});

describe("This Computer agents and names", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); window.localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  // Fault detected: Electron Desktop cannot start a coding agent or name a terminal,
  // unlike Web Desktop and Herdr's own + menu.
  it("starts a chosen agent and renames a terminal with F2", async () => {
    const operator = installOperator({
      "local-terminal:watch": watching([fact("t1", "zsh")]),
      "local-terminal:create": () => ({ status: "ready", id: "t9" }),
      "local-terminal:rename": () => ({ ok: true }),
    });
    render(<TerminalWindowApp />);
    await startShell("Claude Code");
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t9");
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:create", { cols: 100, rows: 30, agent: "claude" });

    fireEvent.click(row(/zsh/));
    operator.command({ command: "rename" });
    const dialog = await screen.findByRole("dialog", { name: "Rename terminal" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Terminal name" }), { target: { value: "review" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:rename", { id: "t1", name: "review" }));
    operator.push([fact("t1", "review")]);
    expect(await findRow(/review/)).toBeTruthy();
  });

  // Fault detected (review of #3300): the open pane kept the old name after a rename.
  it("keeps the new name on the open terminal after it ends", async () => {
    const operator = installOperator({ "local-terminal:watch": watching([fact("t1", "zsh")]), "local-terminal:rename": () => ({ ok: true }) });
    render(<TerminalWindowApp />);
    fireEvent.click(await findRow(/zsh/));
    operator.command({ command: "rename" });
    const dialog = await screen.findByRole("dialog", { name: "Rename terminal" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Terminal name" }), { target: { value: "review" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:rename", { id: "t1", name: "review" }));
    operator.push([]);
    expect(await screen.findByText("review ended")).toBeTruthy();
  });
});

describe("Terminal window shortcuts", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); window.localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const three = [fact("t1", "alpha", { statusAt: 3_000 }), fact("t2", "beta", { statusAt: 2_000 }), fact("t3", "gamma", { statusAt: 1_000 })];

  // Cmd+] / Cmd+[ step through the sidebar; Cmd+1…9 pick a tab of the active space (navigation model).
  it("steps through terminals in sidebar order and selects tabs by number", async () => {
    const operator = installOperator({ "local-terminal:watch": watching(three) });
    render(<TerminalWindowApp />);
    await findRow(/alpha/);
    operator.command({ command: "next" });
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t1");
    operator.command({ command: "next" });
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t2");
    operator.command({ command: "next" });
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t3");
    operator.command({ command: "previous" });
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t2");
    // The tab bar now holds t1, t2, t3 in the order they were opened.
    operator.command({ command: "select", index: 1 });
    await waitFor(() => expect(screen.getByTestId("terminal-view").textContent).toBe("local:t1"));
    operator.command({ command: "select", index: 3 });
    await waitFor(() => expect(screen.getByTestId("terminal-view").textContent).toBe("local:t3"));
    operator.command({ command: "select", index: 9 });
    expect(screen.getByTestId("terminal-view").textContent).toBe("local:t3");
  });

  it("opens the picker, filters by name and opens the match", async () => {
    const operator = installOperator({ "local-terminal:watch": watching(three) });
    render(<TerminalWindowApp />);
    await findRow(/alpha/);
    operator.command({ command: "picker" });
    const dialog = await screen.findByRole("dialog", { name: "Go to terminal" });
    const input = within(dialog).getByRole("textbox", { name: "Terminal name" });
    fireEvent.change(input, { target: { value: "gam" } });
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([expect.stringContaining("gamma")]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t3");
  });

  // Fault detected (Greptile, #3567): pinned terminals led the list, but Cmd+] and the picker ignored them.
  it("steps through terminals in the shown order, pinned first", async () => {
    const operator = installOperator({ "local-terminal:watch": watching(three) });
    render(<TerminalWindowApp />);
    await findRow(/alpha/);
    fireEvent.click(within(screen.getByRole("group", { name: "gamma actions" })).getByRole("button", { name: "Pin terminal" }));
    expect(screen.getByRole("region", { name: "Pinned" })).toBeTruthy();
    operator.command({ command: "next" });
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t3");
  });

  // Fault detected (Greptile, #3567): when live updates shrank the matches, the highlight fell off the list.
  it("keeps the picker's highlight on a remaining match when matches shrink", async () => {
    let facts = three;
    const operator = installOperator({ "local-terminal:watch": watching(() => facts) });
    render(<TerminalWindowApp />);
    await findRow(/alpha/);
    operator.command({ command: "picker" });
    const dialog = await screen.findByRole("dialog", { name: "Go to terminal" });
    const input = within(dialog).getByRole("textbox", { name: "Terminal name" });
    for (let step = 0; step < 3; step += 1) fireEvent.keyDown(input, { key: "ArrowDown" });
    facts = three.slice(0, 2);
    operator.push(facts);
    await waitFor(() => expect(within(dialog).getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "true")).toHaveLength(1));
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByTestId("terminal-view")).textContent).toMatch(/local:t[12]/);
  });

  // Fault detected (Greptile, #3567): ArrowDown moved the highlight below the visible list.
  it("keeps the picker's highlighted match in view", async () => {
    const scrolled: string[] = [];
    const scrollIntoView = vi.fn(function (this: HTMLElement) { scrolled.push(this.textContent ?? ""); });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const operator = installOperator({ "local-terminal:watch": watching(three) });
    render(<TerminalWindowApp />);
    await findRow(/alpha/);
    operator.command({ command: "picker" });
    const dialog = await screen.findByRole("dialog", { name: "Go to terminal" });
    fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "Terminal name" }), { key: "ArrowDown" });
    expect(scrolled.at(-1)).toContain(within(dialog).getAllByRole("button")[1]!.textContent!.slice(0, 4));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("toggles the numbered rail, remembers it, and asks the terminal on screen to find", async () => {
    const operator = installOperator({ "local-terminal:watch": watching(three) });
    const first = render(<TerminalWindowApp />);
    fireEvent.click(await findRow(/alpha/));
    operator.command({ command: "toggle-sidebar" });
    expect(await screen.findByRole("button", { name: "Show sidebar" })).toBeTruthy();
    expect(within(sidebar()).getByRole("button", { name: "alpha" }).textContent).toBe("1");
    operator.command({ command: "find" });
    expect(screen.getByTestId("terminal-view").getAttribute("data-find")).toBe("1");
    first.unmount();
    render(<TerminalWindowApp />);
    expect(await screen.findByRole("button", { name: "Show sidebar" })).toBeTruthy();
  });

  // Hamed, 2026-11-22 (Herdr layout): a machine opened as its own tab shows only its agents.
  it("opens a machine as its own tab, groups by machine, and turns into the rail below 160 px", async () => {
    installOperator({ "local-terminal:watch": watching(three) });
    render(<TerminalWindowApp />);
    await findRow(/alpha/);
    const machines = screen.getByRole("list", { name: "Machines" });
    // This Computer is a space of its own.
    fireEvent.click(document.querySelector<HTMLElement>('li[data-space="local"] button[aria-pressed]')!);
    expect(screen.getByRole("button", { name: /Show all machines \(now This Computer\)/ })).toBeTruthy();
    expect(within(sidebar()).getByRole("button", { name: /alpha/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show all machines/ }));
    fireEvent.click(screen.getByRole("button", { name: "Group by machine" }));
    expect(screen.getByRole("region", { name: "This Computer" })).toBeTruthy();
    const edge = screen.getByRole("separator", { name: "Resize sidebar" });
    for (let step = 0; step < 8; step += 1) fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(await screen.findByRole("button", { name: "Show sidebar" })).toBeTruthy();
  });

  it("starts a new terminal on the selected terminal's machine", async () => {
    const operator = installOperator({ "local-terminal:watch": watching(three), "local-terminal:create": () => ({ status: "ready", id: "t8" }) });
    render(<TerminalWindowApp />);
    fireEvent.click(await findRow(/alpha/));
    operator.command({ command: "new-terminal" });
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:create", { cols: 100, rows: 30 }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t8");
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
    const handlers = { ...events(), onCanonicalSize: vi.fn() };
    const socket = createLocalTerminalSocket("local:t3", handlers);
    socket.resize(132, 43);
    socket.connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:attach", { id: "t3", cols: 132, rows: 43 });
    // Fault detected (Mac, 2026-11-22): a local pane never took a new grid after a split, only scaled.
    expect(handlers.onCanonicalSize).toHaveBeenLastCalledWith({ cols: 132, rows: 43 });

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
    await waitFor(() => expect(handlers.onCanonicalSize).toHaveBeenLastCalledWith({ cols: 80, rows: 24 }));

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
