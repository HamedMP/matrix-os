// @vitest-environment jsdom

import React from "react";
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName }: { sessionName: string }) => <div data-testid="terminal-view">{sessionName}</div>,
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { useConnection } from "@desktop/renderer/src/stores/connection";

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
const workspace = (tabs: Array<{ id: string; name: string; status?: string }>) => ({
  workspaces: [{ id: WS, scope: "main", extraField: "ignored", tabs: tabs.map((tab) => ({ status: "running", ...tab })) }],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const focusListeners: Array<(payload: unknown) => void> = [];
function installOperator() {
  focusListeners.length = 0;
  window.operator = {
    invoke: vi.fn(async (channel: string) => {
      if (channel === "auth:status") return { signedIn: true, handle: "neo", userId: "user_1", platformHost: HOST, runtimeSlot: "primary", authGeneration: 3 };
      if (channel === "runtime:list-computers") return computers;
      if (channel === "app:get-zoom") return { factor: 1 };
      if (channel === "local-terminal:list") return { status: "ready", terminals: [] };
      return { ok: true };
    }),
    on: (channel, callback) => { if (channel === "window:focus-changed") focusListeners.push(callback); return () => undefined; },
  };
}

describe("Terminal window computers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installOperator();
    useConnection.setState(useConnection.getInitialState(), true);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const requests = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url)}`);

  it("asks a computer for its terminals only when it is opened, addressing that computer", async () => {
    fetchMock.mockImplementation(async (url: string) => json(workspace(String(url).includes("runtime=extra")
      ? [{ id: TAB_2, name: "deploy" }] : [{ id: TAB_1, name: "build" }])));
    render(<TerminalWindowApp />);
    const extra = await screen.findByRole("button", { name: /Additional Computer/ });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(extra);
    expect(await screen.findByRole("button", { name: /deploy/ })).toBeTruthy();
    expect(requests()).toEqual([`GET ${HOST}/api/terminal/workspaces?runtime=extra`]);
    expect(extra.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /Main Computer/ }));
    expect(await screen.findByRole("button", { name: /build/ })).toBeTruthy();
    expect(requests()[1]).toBe(`GET ${HOST}/api/terminal/workspaces`);
    expect(fetchMock.mock.calls.every(([, init]) => !new Headers((init as RequestInit).headers).has("authorization"))).toBe(true);
  });

  it("shows tabs created elsewhere once the window regains focus, without a loading flash", async () => {
    let tabs = [{ id: TAB_1, name: "build" }];
    fetchMock.mockImplementation(async () => json(workspace(tabs)));
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Main Computer/ }));
    await screen.findByRole("button", { name: /build/ });
    tabs = [...tabs, { id: TAB_2, name: "started on my phone" }];
    act(() => { for (const listener of focusListeners) listener({ focused: true }); });
    expect(await screen.findByRole("button", { name: /started on my phone/ })).toBeTruthy();
    expect(screen.queryByText("Loading terminals…")).toBeNull();
    // Computers that were never opened are still not asked.
    expect(requests().every((request) => !request.includes("runtime=extra"))).toBe(true);
  });

  it("lists a computer's terminals even when it is opened the instant the list appears", async () => {
    // The click lands before React has run the passive effects of the render
    // that showed the computer; a session reset there used to discard the listing.
    fetchMock.mockImplementation(async () => json(workspace([{ id: TAB_1, name: "build" }])));
    render(<TerminalWindowApp />);
    let clicked = false;
    const observer = new MutationObserver(() => {
      const row = screen.queryByRole("button", { name: /Main Computer/ });
      if (row && !clicked) { clicked = true; row.click(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      expect(await screen.findByRole("button", { name: /build/ })).toBeTruthy();
      expect(clicked).toBe(true);
    } finally { observer.disconnect(); }
  });

  it("attaches the chosen tab on its own computer without touching the app-wide selection", async () => {
    fetchMock.mockImplementation(async () => json(workspace([{ id: TAB_2, name: "deploy" }])));
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Additional Computer/ }));
    fireEvent.click(await screen.findByRole("button", { name: /deploy/ }));

    expect((await screen.findByTestId("terminal-view")).textContent).toBe(`${WS}:${TAB_2}`);
    expect(useConnection.getState()).toMatchObject({ platformHost: HOST, runtimeSlot: "extra" });
    expect(screen.getByRole("button", { name: /deploy/ }).getAttribute("aria-current")).toBe("true");
    expect(window.operator.invoke).not.toHaveBeenCalledWith("runtime:select", expect.anything());
  });

  it("creates a terminal in the computer's main workspace and opens it", async () => {
    let created = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/ensure")) return json({ workspace: { id: WS } });
      if (init?.method === "POST") { created = true; return json({ tab: { id: TAB_1, name: "Terminal" } }, 201); }
      return json(workspace(created ? [{ id: TAB_1, name: "Terminal" }] : []));
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Main Computer/ }));
    await screen.findByRole("list", { name: "Main Computer terminals" });
    fireEvent.click(within(screen.getByRole("list", { name: "Main Computer terminals" })).getByRole("button", { name: "New terminal" }));

    expect((await screen.findByTestId("terminal-view")).textContent).toBe(`${WS}:${TAB_1}`);
    expect(requests()).toContain(`POST ${HOST}/api/terminal/workspaces/ensure`);
    expect(requests()).toContain(`POST ${HOST}/api/terminal/workspaces/${WS}/tabs`);
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/tabs") && (init as RequestInit).method === "POST")!;
    expect(JSON.parse(String((createCall[1] as RequestInit).body))).toEqual({ name: "Terminal", cwd: "" });
  });

  it("keeps a computer's listed terminals when starting another one fails", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (init?.method === "POST"
      ? json({ error: "unavailable" }, 503)
      : json(workspace([{ id: TAB_1, name: "build" }]))));
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Main Computer/ }));
    await screen.findByRole("button", { name: /build/ });
    fireEvent.click(within(screen.getByRole("list", { name: "Main Computer terminals" })).getByRole("button", { name: "New terminal" }));
    expect(await screen.findByText("Couldn't start a terminal. Try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /build/ })).toBeTruthy();
    expect(screen.queryByText("Couldn't reach this computer.")).toBeNull();
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
    fireEvent.click(await screen.findByRole("button", { name: /Main Computer/ }));
    await screen.findByRole("button", { name: /build/ });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(finishCreate).toBeTypeOf("function"));
    // The user picks an existing terminal before the new one is ready.
    fireEvent.click(screen.getByRole("button", { name: /build/ }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe(`${WS}:${TAB_1}`);
    await act(async () => { finishCreate(json({ tab: { id: TAB_2, name: "Terminal" } }, 201)); });
    await waitFor(() => expect(screen.getByRole("button", { name: "New terminal" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByTestId("terminal-view").textContent).toBe(`${WS}:${TAB_1}`);
  });

  it("does not open a terminal whose creation finished after the owner signed out", async () => {
    let signedIn = true;
    const listeners: Array<(payload: unknown) => void> = [];
    window.operator = {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "auth:status") return signedIn
          ? { signedIn: true, handle: "neo", userId: "user_1", platformHost: HOST, runtimeSlot: "primary", authGeneration: 3 }
          : { signedIn: false, platformHost: HOST, authGeneration: 4 };
        if (channel === "runtime:list-computers") return computers;
        if (channel === "app:get-zoom") return { factor: 1 };
        return { ok: true };
      }),
      on: (channel, callback) => { if (channel === "auth:changed") listeners.push(callback); return () => undefined; },
    };
    let finishCreate!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/ensure")) return json({ workspace: { id: WS } });
      if (init?.method === "POST") return new Promise<Response>((resolve) => { finishCreate = resolve; });
      return json(workspace([{ id: TAB_1, name: "build" }]));
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Main Computer/ }));
    await screen.findByRole("button", { name: /build/ });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(finishCreate).toBeTypeOf("function"));

    signedIn = false;
    act(() => { for (const listener of listeners) listener({ signedIn: false }); });
    await screen.findByRole("button", { name: "Sign in" });
    await act(async () => { finishCreate(json({ tab: { id: TAB_2, name: "Terminal" } }, 201)); });

    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(useConnection.getState().status).not.toBe("signed-in");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("scopes a refused credential to its computer and recovers on reconnect", async () => {
    let refuse = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("runtime=extra") && refuse) return json({ error: "jwt expired at db01.internal" }, 401);
      return json(workspace([{ id: TAB_1, name: "build" }]));
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Additional Computer/ }));
    fireEvent.click(screen.getByRole("button", { name: /Main Computer/ }));
    const reconnect = await screen.findByRole("button", { name: "Reconnect" });
    expect(await screen.findByRole("button", { name: /build/ })).toBeTruthy();
    expect(document.body.textContent).not.toContain("db01");
    refuse = false;
    fireEvent.click(reconnect);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull());
    const extraList = screen.getByRole("list", { name: "Additional Computer terminals" });
    expect(within(extraList).getByRole("button", { name: /build/ })).toBeTruthy();
  });

  it("shows a generic retry when a computer cannot be reached or answers with an invalid listing", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes("runtime=extra")
      ? json({ workspaces: [{ id: "../../etc", scope: "main", tabs: [] }] })
      : json({ error: "ECONNREFUSED 10.1.2.3" }, 502)));
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Additional Computer/ }));
    fireEvent.click(screen.getByRole("button", { name: /Main Computer/ }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2));
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
    expect(screen.queryByTestId("terminal-view")).toBeNull();
  });
});
