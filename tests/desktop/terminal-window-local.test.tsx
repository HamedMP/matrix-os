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
import { localTerminalPorts } from "./fixtures/local-terminal-ports";

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

  // ENG-521 canary report: a failed start says what kind of failure it was, as the main process classified it.
  it("says why a terminal on this device did not start", async () => {
    installOperator({ "local-terminal:watch": watching([fact("t1", "zsh")]), "local-terminal:create": () => ({ status: "unavailable", reason: "timeout" }) });
    render(<TerminalWindowApp />);
    await startShell();
    expect(await screen.findByText("Couldn't start a terminal: this device's terminal service did not answer. Try again.")).toBeTruthy();
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
  let ports: ReturnType<typeof localTerminalPorts>;
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); ports = localTerminalPorts(); });
  afterEach(() => { ports.dispose(); vi.restoreAllMocks(); });
  // The view draws output and then says so, as xterm's write callback does.
  const events = () => ({ onState: vi.fn(), onOutput: vi.fn((_data: string | Uint8Array, _seq: number, written?: () => void) => { written?.(); }),
    onGap: vi.fn(), onExit: vi.fn(), onOwnershipChange: vi.fn(), onRepaint: vi.fn() });
  const text = (data: unknown) => (typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array));
  const shown = (handlers: { onOutput: { mock: { calls: unknown[][] } } }) => handlers.onOutput.mock.calls.map(([data, seq]) => [text(data), seq]);
  // The trusted core hands the window the attachment's port before it replies with the id.
  const attached = (attachId: number) => () => { ports.streams.open(attachId); return { ok: true, attachId }; };
  const operatorWithPorts = (local: Record<string, (payload: never) => unknown>) => {
    const operator = installOperator(local);
    window.operator.localTerminalStream = ports.bridge as typeof window.operator.localTerminalStream;
    return operator;
  };
  const ackTotal = () => ports.host.acknowledge.mock.calls.reduce((sum, [, count]) => sum + count, 0);

  it("attaches at the requested size, relays output as bytes in order and forwards input and resize", async () => {
    const operator = operatorWithPorts({ "local-terminal:attach": attached(5), "local-terminal:resize": () => ({ ok: true }), "local-terminal:detach": () => ({ ok: true }) });
    const handlers = { ...events(), onCanonicalSize: vi.fn() };
    const socket = createLocalTerminalSocket("local:t3", handlers);
    socket.resize(132, 43);
    socket.connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:attach", { id: "t3", cols: 132, rows: 43 });
    // Fault detected (Mac, 2026-11-22): a local pane never took a new grid after a split, only scaled.
    expect(handlers.onCanonicalSize).toHaveBeenLastCalledWith({ cols: 132, rows: 43 });
    // The core repaints the whole terminal on attach, so the view starts empty.
    expect(handlers.onRepaint).toHaveBeenCalledTimes(1);

    ports.output(9, "someone else");
    ports.output(5, "one");
    ports.output(5, "two");
    await waitFor(() => expect(shown(handlers)).toEqual([["one", 1], ["two", 2]]));
    expect(Object.prototype.toString.call(handlers.onOutput.mock.calls[0]![0])).toBe("[object Uint8Array]");
    // Credit for this terminal's output only.
    await waitFor(() => expect(ackTotal()).toBe(2));
    expect(ports.host.acknowledge.mock.calls.every(([attachId]) => attachId === 5)).toBe(true);

    socket.sendInput("ls\r");
    socket.sendBinary("\x1b[M");
    socket.resize(80, 24);
    await waitFor(() => expect(ports.host.input).toHaveBeenCalledTimes(2));
    expect(ports.host.input.mock.calls).toEqual([[5, "ls\r", false], [5, "\x1b[M", true]]);
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:resize", { attachId: 5, cols: 80, rows: 24 });
    await waitFor(() => expect(handlers.onCanonicalSize).toHaveBeenLastCalledWith({ cols: 80, rows: 24 }));

    socket.detach();
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:detach", { attachId: 5 });
    socket.sendInput("ignored");
    ports.output(5, "after detach");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports.host.input).toHaveBeenCalledTimes(2);
    expect(handlers.onOutput).toHaveBeenCalledTimes(2);
  });

  it("sends everything typed in one turn as one message", async () => {
    operatorWithPorts({ "local-terminal:attach": attached(5) });
    const handlers = events();
    const socket = createLocalTerminalSocket("local:t3", handlers);
    socket.connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    for (const key of ["g", "i", "t", " ", "s", "\r"]) socket.sendInput(key);
    await waitFor(() => expect(ports.host.input).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports.host.input.mock.calls).toEqual([[5, "git s\r", false]]);
  });

  it("reports ended when the terminal closes or cannot be attached", async () => {
    const operator = operatorWithPorts({ "local-terminal:attach": attached(2), "local-terminal:detach": () => ({ ok: true }) });
    const handlers = events();
    createLocalTerminalSocket("local:t1", handlers).connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    ports.closed(2);
    await waitFor(() => expect(handlers.onState).toHaveBeenLastCalledWith("ended"));
    expect(operator.invoke).not.toHaveBeenCalledWith("local-terminal:detach", expect.anything());

    operatorWithPorts({ "local-terminal:attach": () => ({ ok: false }) });
    const refusedHandlers = events();
    createLocalTerminalSocket("local:t1", refusedHandlers).connect();
    await waitFor(() => expect(refusedHandlers.onState).toHaveBeenLastCalledWith("ended"));
  });

  it("shows the history that arrived before the attach call returned, in order and in full", async () => {
    let resolveAttach!: (value: unknown) => void;
    operatorWithPorts({ "local-terminal:attach": () => new Promise((resolve) => { resolveAttach = resolve; }) });
    const handlers = events();
    createLocalTerminalSocket("local:t1", handlers).connect();
    ports.output(4, "another terminal");
    ports.output(6, "history ");
    for (let index = 0; index < 299; index += 1) ports.output(6, "h");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handlers.onOutput).not.toHaveBeenCalled();
    resolveAttach({ ok: true, attachId: 6 });
    await waitFor(() => expect(handlers.onOutput).toHaveBeenCalledTimes(300));
    expect(text(handlers.onOutput.mock.calls[0]![0])).toBe("history ");
    // The repaint comes first, then the core's paint.
    expect(handlers.onRepaint.mock.invocationCallOrder[0]!).toBeLessThan(handlers.onOutput.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(ackTotal()).toBe(300));
  });

  it("returns output credit only after the view has drawn the output", async () => {
    operatorWithPorts({ "local-terminal:attach": attached(7) });
    const drawn: Array<() => void> = [];
    const handlers = { ...events(), onOutput: vi.fn((_data: string | Uint8Array, _seq: number, written?: () => void) => { if (written) drawn.push(written); }) };
    createLocalTerminalSocket("local:t1", handlers).connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    ports.output(7, "a flood of output");
    await waitFor(() => expect(drawn).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports.host.acknowledge).not.toHaveBeenCalled();
    drawn[0]!();
    drawn[0]!();
    await waitFor(() => expect(ports.host.acknowledge.mock.calls).toEqual([[7, 1]]));
  });

  it("splits a very large burst of acknowledgements instead of losing it", async () => {
    operatorWithPorts({ "local-terminal:attach": attached(7) });
    const handlers = events();
    createLocalTerminalSocket("local:t1", handlers).connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    // A hidden window draws thousands of queued chunks in one slice.
    const drawn: Array<() => void> = [];
    handlers.onOutput.mockImplementation((_data, _seq, written) => { if (written) drawn.push(written); });
    for (let index = 0; index < 5_000; index += 1) ports.output(7, "x");
    await waitFor(() => expect(drawn).toHaveLength(5_000));
    for (const written of drawn) written();
    await waitFor(() => expect(ackTotal()).toBe(5_000));
    expect(Math.max(...ports.host.acknowledge.mock.calls.map(([, count]) => count))).toBeLessThanOrEqual(4_096);
  });

  it("acknowledges output on arrival while the window is hidden, so a background program is not slowed", async () => {
    operatorWithPorts({ "local-terminal:attach": attached(7) });
    // The view never reports drawing: a throttled, hidden page.
    const handlers = { ...events(), onOutput: vi.fn() };
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    createLocalTerminalSocket("local:t1", handlers).connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    ports.output(7, "build output");
    await waitFor(() => expect(ports.host.acknowledge).toHaveBeenCalledWith(7, 1));
    expect(handlers.onOutput).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it("never cuts a pasted character in half when splitting long input", async () => {
    const emoji = "\u{1F600}";
    const pasted = `${"a".repeat(32_767)}${emoji}${"b".repeat(10)}`;
    expect(inputChunkEnd(pasted, 0)).toBe(32_767);
    expect(inputChunkEnd(pasted, 32_767)).toBe(pasted.length);
    expect(inputChunkEnd("short", 0)).toBe(5);

    operatorWithPorts({ "local-terminal:attach": attached(3) });
    const handlers = events();
    const socket = createLocalTerminalSocket("local:t1", handlers);
    socket.connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    socket.sendInput(pasted);
    await waitFor(() => expect(ports.host.input).toHaveBeenCalledTimes(2));
    const sent = ports.host.input.mock.calls.map(([, data]) => data);
    expect(sent.join("")).toBe(pasted);
    // Each piece is well-formed on its own, so encoding it cannot corrupt the character.
    for (const piece of sent) expect(piece.isWellFormed()).toBe(true);
  });

  it("stops accepting typing once the trusted core no longer holds the attachment", async () => {
    operatorWithPorts({ "local-terminal:attach": attached(3), "local-terminal:detach": () => ({ ok: true }) });
    ports.host.input.mockReturnValue(false);
    const handlers = events();
    const socket = createLocalTerminalSocket("local:t1", handlers);
    socket.connect();
    await waitFor(() => expect(handlers.onState).toHaveBeenCalledWith("attached"));
    socket.sendInput("ls\r");
    await waitFor(() => expect(handlers.onState).toHaveBeenLastCalledWith("ended"));
    socket.sendInput("more");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports.host.input).toHaveBeenCalledTimes(1);
  });

  it("shows a shell that ended while it was attaching as ended, after its last output", async () => {
    let resolveAttach!: (value: unknown) => void;
    const operator = operatorWithPorts({ "local-terminal:attach": () => new Promise((resolve) => { resolveAttach = resolve; }) });
    const handlers = events();
    createLocalTerminalSocket("local:t1", handlers).connect();
    ports.output(6, "exit\r\n");
    ports.closed(6);
    ports.closed(9);
    resolveAttach({ ok: true, attachId: 6 });
    await waitFor(() => expect(handlers.onState).toHaveBeenLastCalledWith("ended"));
    expect(handlers.onOutput.mock.calls.map(([data]) => text(data))).toEqual(["exit\r\n"]);
    // Nothing is left to detach.
    expect(operator.invoke).not.toHaveBeenCalledWith("local-terminal:detach", expect.anything());
  });

  it("sends the pane's size to the shell when it was resized while attaching", async () => {
    let resolveAttach!: (value: unknown) => void;
    const operator = operatorWithPorts({ "local-terminal:attach": () => new Promise((resolve) => { resolveAttach = resolve; }),
      "local-terminal:resize": () => ({ ok: true }) });
    const handlers = events();
    const socket = createLocalTerminalSocket("local:t1", handlers);
    socket.resize(100, 30);
    socket.connect();
    socket.resize(140, 50);
    expect(operator.invoke).not.toHaveBeenCalledWith("local-terminal:resize", expect.anything());
    ports.streams.open(4);
    resolveAttach({ ok: true, attachId: 4 });
    await waitFor(() => expect(operator.invoke).toHaveBeenCalledWith("local-terminal:resize", { attachId: 4, cols: 140, rows: 50 }));
    expect(operator.invoke).toHaveBeenCalledWith("local-terminal:attach", { id: "t1", cols: 100, rows: 30 });
  });

  it("detaches an attachment that completes after the view already left", async () => {
    let resolveAttach!: (value: unknown) => void;
    const operator = operatorWithPorts({ "local-terminal:attach": () => new Promise((resolve) => { resolveAttach = resolve; }),
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
