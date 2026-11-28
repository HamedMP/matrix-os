// @vitest-environment jsdom

import React, { useEffect, useLayoutEffect } from "react";
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName }: { sessionName: string }) => <div data-testid="terminal-view">{sessionName}</div>,
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useComputerTerminals } from "@desktop/renderer/src/features/terminal-window/use-computer-terminals";

// These tests render the whole window and wait on mocked network replies. The
// default one-second wait is too tight for the first render on a loaded CI
// runner (it failed there once); the assertions themselves are unchanged.
configure({ asyncUtilTimeout: 5_000 });

const HOST = "https://app.matrix-os.com";
const WS = `tws_${"a".repeat(32)}`;
const TAB_1 = `tt_${"1".repeat(32)}`;
const TAB_2 = `tt_${"2".repeat(32)}`;
const computers = {
  items: [
    { handle: "neo", runtimeSlot: "primary", label: "Main Computer", availability: "available", kind: "customer", gatewayPath: "/vm/neo", capabilities: [] },
    { handle: "neo-extra", runtimeSlot: "extra", label: "Additional Computer", availability: "available", kind: "customer", gatewayPath: "/vm/neo-extra?runtime=extra", capabilities: [] },
  ],
  selectedSlot: "primary", hasMore: false, limit: 20,
};
const workspace = (tabs: Array<{ id: string; name: string; status?: string; revision?: number }>) => ({
  workspaces: [{ id: WS, scope: "main", extraField: "ignored", tabs: tabs.map((tab) => ({ status: "running", revision: 1, ...tab })) }],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tabFacts = (tabId: string, name: string, extra: Record<string, unknown> = {}) => ({ ref: { workspaceId: WS, tabId }, name, cwd: "", state: "live", ...extra });

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  static for(slot: string) {
    return FakeWebSocket.all.filter((socket) => (slot === "primary" ? !socket.url.includes("runtime=") : socket.url.endsWith(`runtime=${slot}`))).at(-1);
  }
}

/** Opens a computer's events stream and sends it a snapshot (and attention). */
async function stream(slot: string, tabs: unknown[], attention?: Record<string, { doneAt: string; seen: boolean }>) {
  await waitFor(() => expect(FakeWebSocket.for(slot)).toBeTruthy());
  const socket = FakeWebSocket.for(slot)!;
  act(() => {
    socket.readyState = 1;
    socket.onopen?.({});
    socket.onmessage?.({ data: JSON.stringify({ type: "snapshot", seq: 1, tabs }) });
    if (attention) socket.onmessage?.({ data: JSON.stringify({ type: "attention", seq: 2, tabs: attention }) });
  });
  return socket;
}

const listeners = new Map<string, Array<(payload: unknown) => void>>();
const emit = (channel: string, payload: unknown) => { for (const listener of listeners.get(channel) ?? []) listener(payload); };
function installOperator(auth: () => unknown = () => ({ signedIn: true, handle: "neo", userId: "user_1", platformHost: HOST, runtimeSlot: "primary", authGeneration: 3 })) {
  listeners.clear();
  window.operator = {
    invoke: vi.fn(async (channel: string) => {
      if (channel === "auth:status") return auth();
      if (channel === "runtime:list-computers") return computers;
      if (channel === "app:get-zoom") return { factor: 1 };
      if (channel === "local-terminal:watch") return { status: "ready", terminals: [] };
      return { ok: true };
    }),
    on: (channel, callback) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== callback));
    },
  };
}

beforeAll(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

describe("Terminal window computers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installOperator();
    useConnection.setState(useConnection.getInitialState(), true);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    FakeWebSocket.all = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    window.localStorage.clear();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const requests = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url)}`);
  const sidebar = () => screen.getByRole("navigation", { name: "Terminals" });
  // Each listing also asks that computer's gateway for its Herdr sessions (spec 2701).
  const tabRequests = () => requests().filter((request) => request.includes("/api/terminal/workspaces"));

  it("streams each available computer's terminals into the status sections, with no listing requests", async () => {
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build", { agentStatus: "working" })]);
    await stream("extra", [tabFacts(TAB_2, "deploy", { agentStatus: "blocked" })]);
    const needsYou = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needsYou).getByRole("button", { name: /deploy/ }).textContent).toContain("neo-extra");
    expect(within(screen.getByRole("region", { name: "Working" })).getByRole("button", { name: /build/ })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Hamed, 2026-11-22: a computer opened as its own tab, and its spaces, filter the agents list.
  it("shows only one computer's agents, or one of its spaces, when it is opened as a tab", async () => {
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build"), { ...tabFacts(`tt_${"3".repeat(32)}`, "site"), projectId: "web" }]);
    await stream("extra", [tabFacts(TAB_2, "deploy")]);
    const machines = screen.getByRole("list", { name: "Machines" });
    // The space itself (aria-pressed), not its chevron or options button.
    const space = (list: string, name: string) => within(within(machines).getByRole("list", { name: list })).getAllByRole("button", { name: new RegExp(name) })
      .find((button) => button.hasAttribute("aria-pressed"))!;
    // The computer itself is a space; its main workspace is not a row of its own.
    fireEvent.click(document.querySelector<HTMLElement>('li[data-space="computer:extra"] button[aria-pressed]')!);
    await waitFor(() => expect(within(sidebar()).queryByRole("button", { name: /build/ })).toBeNull());
    expect(within(sidebar()).getByRole("button", { name: /deploy/ })).toBeTruthy();
    fireEvent.click(within(machines).getByRole("button", { name: "Show neo projects" }));
    fireEvent.click(space("neo spaces", "web"));
    await waitFor(() => expect(within(sidebar()).getAllByRole("button").map((button) => button.textContent).join()).toContain("site"));
    expect(within(sidebar()).queryByRole("button", { name: /build/ })).toBeNull();

    // The tab bar follows the chosen space too; All shows every open tab again.
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /build/ }));
    fireEvent.click(within(sidebar()).getByRole("button", { name: /site/ }));
    const tabNames = () => within(screen.getByRole("tablist", { name: "Open terminals" })).getAllByRole("tab").map((tab) => tab.textContent);
    await waitFor(() => expect(tabNames()).toEqual(["build", "site"]));
    fireEvent.click(within(within(machines).getByRole("list", { name: "neo spaces" })).getAllByRole("button", { name: /web/ })
      .find((button) => button.hasAttribute("aria-pressed"))!);
    await waitFor(() => expect(tabNames()).toEqual(["site"]));
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    await waitFor(() => expect(tabNames()).toEqual(["build", "site"]));
  });

  // Hamed, 2026-11-22 (navigation model): Ctrl+1…9 switch space in the sidebar's order, Ctrl+0 is All.
  it("switches the active space with Ctrl+digits and back to All with Ctrl+0", async () => {
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build"), { ...tabFacts(`tt_${"3".repeat(32)}`, "site"), projectId: "web" }]);
    await stream("extra", [tabFacts(TAB_2, "deploy")]);
    const chip = () => screen.queryByRole("button", { name: /Show all machines/ })?.getAttribute("aria-label");
    // Order: This Computer, then neo and its project web, then neo-extra.
    act(() => emit("terminal-window:command", { command: "space", index: 3 }));
    await waitFor(() => expect(chip()).toBe("Show all machines (now neo · web)"));
    expect(within(sidebar()).queryByRole("button", { name: /build/ })).toBeNull();
    act(() => emit("terminal-window:command", { command: "space", index: 4 }));
    await waitFor(() => expect(chip()).toBe("Show all machines (now neo-extra)"));
    act(() => emit("terminal-window:command", { command: "space", index: 9 }));
    expect(chip()).toBe("Show all machines (now neo-extra)");
    act(() => emit("terminal-window:command", { command: "space", index: 0 }));
    await waitFor(() => expect(chip()).toBeUndefined());
  });

  // Hamed, 2026-11-22 (navigation model): a terminal's ↗ opens it as a tab of its own space.
  it("opens a terminal into a tab of its space from its row", async () => {
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build"), { ...tabFacts(`tt_${"3".repeat(32)}`, "site"), projectId: "web" }]);
    const actions = await screen.findByRole("group", { name: "site actions" });
    fireEvent.click(within(actions).getByRole("button", { name: "Open in a tab" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Show all machines/ }).getAttribute("aria-label")).toBe("Show all machines (now neo · web)"));
    expect(within(sidebar()).getByRole("button", { name: /site/ }).getAttribute("aria-current")).toBe("true");
  });

  // Hamed, 2026-11-22 (navigation model): the top bar shows the active space as a chip and only its
  // tabs; Cmd+1…9 pick among them; Cmd+T starts a terminal in that space.
  it("keeps tabs, Cmd+digits and new terminals inside the active space", async () => {
    const WEB_WS = `tws_${"b".repeat(32)}`;
    const TAB_3 = `tt_${"3".repeat(32)}`;
    const TAB_4 = `tt_${"4".repeat(32)}`;
    const NEW_TAB = `tt_${"5".repeat(32)}`;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).endsWith("/tabs")) return json({ tab: { id: NEW_TAB, name: "Terminal" } }, 201);
      return json(workspace([]));
    });
    render(<TerminalWindowApp />);
    await stream("primary", [
      tabFacts(TAB_1, "build"),
      { ...tabFacts(TAB_3, "site"), ref: { workspaceId: WEB_WS, tabId: TAB_3 }, projectId: "web", cwd: "/srv/web" },
      { ...tabFacts(TAB_4, "docs"), ref: { workspaceId: WEB_WS, tabId: TAB_4 }, projectId: "web", cwd: "/srv/web" },
    ]);
    for (const name of [/build/, /site/, /docs/]) fireEvent.click(await within(sidebar()).findByRole("button", { name }));
    const tabNames = () => within(screen.getByRole("tablist", { name: "Open terminals" })).getAllByRole("tab").map((tab) => tab.textContent);
    await waitFor(() => expect(tabNames()).toEqual(["build", "site", "docs"]));
    expect(screen.getByRole("status", { name: "All spaces" })).toBeTruthy();
    // Space 3: This Computer's home, neo's main, then neo's web.
    act(() => emit("terminal-window:command", { command: "space", index: 3 }));
    await waitFor(() => expect(tabNames()).toEqual(["site", "docs"]));
    expect(screen.getByRole("status", { name: "Space web on neo" })).toBeTruthy();
    // The terminal on screen (docs) is in web, so it stays.
    await waitFor(() => expect(screen.getByTestId("terminal-view").textContent).toBe(`${WEB_WS}:${TAB_4}`));
    // A space with no open tab shows nothing until one is opened there.
    act(() => emit("terminal-window:command", { command: "space", index: 4 }));
    await waitFor(() => expect(screen.queryByTestId("terminal-view")).toBeNull());
    // Back in web with nothing on screen: its first tab shows.
    act(() => emit("terminal-window:command", { command: "space", index: 3 }));
    await waitFor(() => expect(screen.getByTestId("terminal-view").textContent).toBe(`${WEB_WS}:${TAB_3}`));
    act(() => emit("terminal-window:command", { command: "select", index: 2 }));
    await waitFor(() => expect(within(sidebar()).getByRole("button", { name: /docs/ }).getAttribute("aria-current")).toBe("true"));
    act(() => emit("terminal-window:command", { command: "select", index: 1 }));
    await waitFor(() => expect(within(sidebar()).getByRole("button", { name: /site/ }).getAttribute("aria-current")).toBe("true"));
    act(() => emit("terminal-window:command", { command: "new-terminal" }));
    await waitFor(() => expect(requests()).toContain(`POST ${HOST}/api/terminal/workspaces/${WEB_WS}/tabs`));
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/tabs") && (init as RequestInit).method === "POST")!;
    expect(JSON.parse(String((createCall[1] as RequestInit).body))).toEqual({ name: "Terminal", cwd: "/srv/web" });

    // A computer is a space itself: its chip names it, and Cmd+T starts the terminal on it (its main workspace).
    act(() => emit("terminal-window:command", { command: "space", index: 2 }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Space neo" })).toBeTruthy());
    fetchMock.mockClear();
    act(() => emit("terminal-window:command", { command: "new-terminal" }));
    await waitFor(() => expect(requests()).toContain(`POST ${HOST}/api/terminal/workspaces/ensure`));
  });

  // Fault detected (Greptile, #3569): closing a tab opened a hidden tab from another space, and a terminal
  // that finished starting late took the screen from a newer choice.
  it("closes a tab to its neighbour in the space, and keeps a newer choice over a late new terminal", async () => {
    const WEB_WS = `tws_${"b".repeat(32)}`;
    const TAB_3 = `tt_${"3".repeat(32)}`;
    const TAB_4 = `tt_${"4".repeat(32)}`;
    let finish: (value: unknown) => void = () => undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).endsWith("/tabs")) return new Promise((resolve) => { finish = resolve; });
      return json(workspace([]));
    });
    render(<TerminalWindowApp />);
    await stream("primary", [
      tabFacts(TAB_1, "build"),
      { ...tabFacts(TAB_3, "site"), ref: { workspaceId: WEB_WS, tabId: TAB_3 }, projectId: "web" },
      { ...tabFacts(TAB_4, "docs"), ref: { workspaceId: WEB_WS, tabId: TAB_4 }, projectId: "web" },
    ]);
    // Opened in this order, so the bar interleaves spaces: site, build, docs.
    for (const name of [/site/, /build/, /docs/]) fireEvent.click(await within(sidebar()).findByRole("button", { name }));
    act(() => emit("terminal-window:command", { command: "space", index: 3 }));
    const tabNames = () => within(screen.getByRole("tablist", { name: "Open terminals" })).getAllByRole("tab").map((tab) => tab.textContent);
    await waitFor(() => expect(tabNames()).toEqual(["site", "docs"]));
    fireEvent.click(screen.getByRole("button", { name: "Close tab docs" }));
    await waitFor(() => expect(screen.getByTestId("terminal-view").textContent).toBe(`${WEB_WS}:${TAB_3}`));

    act(() => emit("terminal-window:command", { command: "new-terminal" }));
    await waitFor(() => expect(requests()).toContain(`POST ${HOST}/api/terminal/workspaces/${WEB_WS}/tabs`));
    // While it starts, the person opens docs; the late terminal must not take the screen.
    fireEvent.click(within(sidebar()).getByRole("button", { name: /docs/ }));
    await waitFor(() => expect(screen.getByTestId("terminal-view").textContent).toBe(`${WEB_WS}:${TAB_4}`));
    await act(async () => { finish(json({ tab: { id: `tt_${"5".repeat(32)}`, name: "Terminal" } }, 201)); });
    expect(screen.getByTestId("terminal-view").textContent).toBe(`${WEB_WS}:${TAB_4}`);
  });

  // Spec 2706: the overview previews a Matrix terminal's screen through its gateway.
  it("previews a computer terminal's screen in the overview", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes("/read")
      ? json({ screen: "deploying…\nstep 3/5 done\n", history: "", lines: 0 })
      : json(workspace([]))));
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "deploy")]);
    act(() => emit("terminal-window:command", { command: "overview" }));
    const overview = await screen.findByRole("main", { name: "Overview" });
    await waitFor(() => expect(within(overview).getByLabelText("deploy preview").textContent).toBe("deploying…\nstep 3/5 done"));
    expect(requests()).toContain(`GET ${HOST}/api/terminal/workspaces/${WS}/tabs/${TAB_1}/read?lines=0`);
  });

  it("attaches the chosen tab on its own computer without touching the app-wide selection, and marks it seen", async () => {
    render(<TerminalWindowApp />);
    await stream("primary", []);
    const socket = await stream("extra", [tabFacts(TAB_2, "deploy", { state: "finished", exitCode: 0 })],
      { [`${WS}:${TAB_2}`]: { doneAt: "2026-11-21T10:00:00.000Z", seen: false } });
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /deploy/ }));

    expect((await screen.findByTestId("terminal-view")).textContent).toBe(`${WS}:${TAB_2}`);
    expect(useConnection.getState()).toMatchObject({ platformHost: HOST, runtimeSlot: "extra" });
    expect(within(sidebar()).getByRole("button", { name: /deploy/ }).getAttribute("aria-current")).toBe("true");
    expect(window.operator.invoke).not.toHaveBeenCalledWith("runtime:select", expect.anything());
    expect(socket.sent).toContain(JSON.stringify({ type: "seen", ref: { workspaceId: WS, tabId: TAB_2 } }));
    // Seen: the finished tab leaves Done for Idle.
    expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Idle" })).getByRole("button", { name: /deploy/ })).toBeTruthy();
  });

  it("creates a terminal in the computer's main workspace and opens it", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/ensure")) return json({ workspace: { id: WS } });
      if (init?.method === "POST") return json({ tab: { id: TAB_1, name: "Terminal" } }, 201);
      return json(workspace([{ id: TAB_1, name: "Terminal" }]));
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "New terminal on neo" }));

    expect((await screen.findByTestId("terminal-view")).textContent).toBe(`${WS}:${TAB_1}`);
    expect(requests()).toContain(`POST ${HOST}/api/terminal/workspaces/ensure`);
    expect(requests()).toContain(`POST ${HOST}/api/terminal/workspaces/${WS}/tabs`);
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/tabs") && (init as RequestInit).method === "POST")!;
    expect(JSON.parse(String((createCall[1] as RequestInit).body))).toEqual({ name: "Terminal", cwd: "" });
  });

  it("keeps a computer's terminals when starting another one fails", async () => {
    fetchMock.mockImplementation(async () => json({ error: "unavailable" }, 503));
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build")]);
    fireEvent.click(await screen.findByRole("button", { name: "New terminal on neo" }));
    // ENG-521 canary report: the row says what kind of failure it was (here the computer's 503),
    // never what the computer said.
    expect(await screen.findByText("Couldn't start a terminal: the computer had an error (503). Try again.")).toBeTruthy();
    expect(within(sidebar()).getByRole("button", { name: /build/ })).toBeTruthy();
  });

  // Fault detected (Greptile, #3639): a successful answer that was not JSON lost its reason.
  it("says when a computer answers a new terminal with something that is not JSON", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/ensure")
      ? new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })
      : json(workspace([]))));
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build")]);
    fireEvent.click(await screen.findByRole("button", { name: "New terminal on neo" }));
    expect(await screen.findByText("Couldn't start a terminal: the computer's answer wasn't understood. It may need an update.")).toBeTruthy();
  });

  it("says when a computer's answer to a new terminal is not understood", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/ensure") ? json({ workspace: { id: "not-a-workspace-id" } }) : json(workspace([]))));
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build")]);
    fireEvent.click(await screen.findByRole("button", { name: "New terminal on neo" }));
    expect(await screen.findByText("Couldn't start a terminal: the computer's answer wasn't understood. It may need an update.")).toBeTruthy();
  });

  // Fault detected (Greptile, #3567): a refused credential while starting a terminal failed silently.
  it("asks to reconnect when a computer refuses the credential for a new terminal, and retries", async () => {
    let refuse = true;
    fetchMock.mockImplementation(async () => (refuse ? json({ error: "jwt expired at db01.internal" }, 401) : json(workspace([]))));
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "New terminal on neo" }));
    const reconnect = await screen.findByRole("button", { name: "Reconnect" });
    expect(screen.getByText("This computer needs you to reconnect.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("db01");
    refuse = false;
    fireEvent.click(reconnect);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull());
  });

  it("does not take the pane from a terminal the user opened while another was being created", async () => {
    let finishCreate!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/ensure")) return json({ workspace: { id: WS } });
      if (init?.method === "POST") return new Promise<Response>((resolve) => { finishCreate = resolve; });
      return json(workspace([{ id: TAB_1, name: "build" }]));
    });
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build")]);
    const create = await screen.findByRole("button", { name: "New terminal on neo" });
    fireEvent.click(create);
    await waitFor(() => expect(finishCreate).toBeTypeOf("function"));
    fireEvent.click(within(sidebar()).getByRole("button", { name: /build/ }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe(`${WS}:${TAB_1}`);
    await act(async () => { finishCreate(json({ tab: { id: TAB_2, name: "Terminal" } }, 201)); });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    expect(screen.getByTestId("terminal-view").textContent).toBe(`${WS}:${TAB_1}`);
  });

  it("does not open a terminal whose creation finished after the owner signed out", async () => {
    let signedIn = true;
    installOperator(() => (signedIn
      ? { signedIn: true, handle: "neo", userId: "user_1", platformHost: HOST, runtimeSlot: "primary", authGeneration: 3 }
      : { signedIn: false, platformHost: HOST, authGeneration: 4 }));
    let finishCreate!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/ensure")) return json({ workspace: { id: WS } });
      if (init?.method === "POST") return new Promise<Response>((resolve) => { finishCreate = resolve; });
      return json(workspace([{ id: TAB_1, name: "build" }]));
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "New terminal on neo" }));
    await waitFor(() => expect(finishCreate).toBeTypeOf("function"));

    signedIn = false;
    act(() => emit("auth:changed", { signedIn: false }));
    await screen.findByRole("button", { name: "Sign in" });
    await act(async () => { finishCreate(json({ tab: { id: TAB_2, name: "Terminal" } }, 201)); });

    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(useConnection.getState().status).not.toBe("signed-in");
    // Every computer's stream closed with the session.
    expect(FakeWebSocket.all.every((socket) => socket.readyState === 3)).toBe(true);
  });

  it("renames a computer tab with F2 at the revision it was read at", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "PATCH"
      ? json({ tab: { id: TAB_1, name: "renamed" } })
      : json(workspace([{ id: TAB_1, name: "build", revision: 7 }]))));
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build")]);
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /build/ }));
    act(() => emit("terminal-window:command", { command: "rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename terminal" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Terminal name" }), { target: { value: "renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(requests()).toContain(`PATCH ${HOST}/api/terminal/workspaces/${WS}/tabs/${TAB_1}`));
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ name: "renamed", baseRevision: 7 });
  });

  // Fault detected (Greptile, #3567): failed computer actions only reached the console.
  it("says so when renaming or ending a computer terminal did not work", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "GET" || !init?.method
      ? json(workspace([{ id: TAB_1, name: "build" }]))
      : json({ error: "conflict at db01.internal" }, 409)));
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build")]);
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /build/ }));
    act(() => emit("terminal-window:command", { command: "rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename terminal" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Terminal name" }), { target: { value: "renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("Couldn't rename that terminal. Try again.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("db01");
  });

  // Fault detected (Greptile, #3567): an available computer whose stream never connected looked like one with no terminals.
  it("shows an available computer as connecting until its stream connects", async () => {
    render(<TerminalWindowApp />);
    expect(await screen.findByText("Main Computer · Connecting…")).toBeTruthy();
    await stream("primary", []);
    expect(await screen.findByText("Main Computer · Available")).toBeTruthy();
  });

  it("asks before Cmd+W ends a running computer terminal, and removes a finished one at once", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build", { agentStatus: "working" }), tabFacts(TAB_2, "old", { state: "finished", exitCode: 0 })]);
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /build/ }));
    act(() => emit("terminal-window:command", { command: "close-terminal" }));
    const dialog = await screen.findByRole("alertdialog", { name: /^End “/ });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "End terminal" }));
    await waitFor(() => expect(requests()).toEqual([`DELETE ${HOST}/api/terminal/workspaces/${WS}/tabs/${TAB_1}`]));
    await waitFor(() => expect(screen.queryByTestId("terminal-view")).toBeNull());

    fireEvent.click(within(sidebar()).getByRole("button", { name: /old/ }));
    act(() => emit("terminal-window:command", { command: "close-terminal" }));
    await waitFor(() => expect(requests()).toContain(`DELETE ${HOST}/api/terminal/workspaces/${WS}/tabs/${TAB_2}`));
  });

  // Fault detected (Greptile, #3569): a split put the new terminal in main at home instead of beside the source.
  it("splits a computer terminal with a new tab in the same workspace and folder", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST"
      ? json({ tab: { id: TAB_2, name: "Terminal" } }, 201)
      : json(workspace([{ id: TAB_1, name: "build" }, { id: TAB_2, name: "Terminal" }]))));
    window.localStorage.clear();
    render(<TerminalWindowApp />);
    await stream("primary", [tabFacts(TAB_1, "build", { cwd: "projects/app" })]);
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /build/ }));
    act(() => emit("terminal-window:command", { command: "split-right" }));
    await waitFor(() => expect(requests()).toContain(`POST ${HOST}/api/terminal/workspaces/${WS}/tabs`));
    expect(requests()).not.toContain(`POST ${HOST}/api/terminal/workspaces/ensure`);
    const create = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((create[1] as RequestInit).body))).toEqual({ name: "Terminal", cwd: "projects/app" });
  });

  it("refreshes a newly committed listing when focus arrives before passive effects", async () => {
    let tabs = [{ id: TAB_1, name: "build" }];
    let focused = false;
    fetchMock.mockImplementation(async () => json(workspace(tabs)));
    function FocusDuringCommit() {
      const { terminals, load } = useComputerTerminals(HOST, "focus-during-commit");
      useEffect(() => { void load("primary"); }, [load]);
      useLayoutEffect(() => {
        if (focused || terminals.primary?.status !== "ready") return;
        focused = true;
        tabs = [...tabs, { id: TAB_2, name: "started on my phone" }];
        emit("window:focus-changed", { focused: true });
      }, [terminals]);
      const state = terminals.primary;
      return state?.status === "ready"
        ? <>{state.tabs.map(tab => <button key={tab.refKey}>{tab.name}</button>)}</>
        : <p>Loading terminals…</p>;
    }
    render(<FocusDuringCommit />);
    expect(await screen.findByRole("button", { name: "started on my phone" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "build" })).toBeTruthy();
    expect(screen.queryByText("Loading terminals…")).toBeNull();
    expect(tabRequests()).toHaveLength(2);
  });
});
