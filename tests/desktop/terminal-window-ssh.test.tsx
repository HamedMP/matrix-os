// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName }: { sessionName: string }) => <div data-testid="terminal-view">{sessionName}</div>,
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";

// Spec 2706 layer 7: add a machine reached over ssh from the sidebar, as in
// Herdr; its terminals show under it, and a host key or password only the
// person can answer is answered in a terminal running ssh.

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

type Machine = { name: string; target: string; state: string; temporary: boolean };
const fact = (id: string, title: string) => ({ id, title, status: null, statusAt: Date.now(), turn: 0, seenTurn: null, finished: false });

function installOperator(options: { machines?: Machine[]; add?: (payload: { target: string; name?: string }) => unknown; facts?: unknown[] } = {}) {
  let machines = options.machines ?? [];
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      case "auth:status": return { signedIn: false, platformHost: "https://app.matrix-os.com", authGeneration: 0 };
      case "state:get": return { value: null };
      case "app:get-zoom": return { factor: 1 };
      case "local-terminal:watch": return { status: "ready", terminals: [...(options.facts ?? []), fact("vps/t5", "Terminal")] };
      case "local-terminal:machines": return { status: "ready", machines };
      case "local-terminal:machine-add": {
        const result = options.add?.(payload as { target: string; name?: string }) ?? { ok: false, reason: "unavailable" };
        if ((result as { ok: boolean }).ok) machines = [...machines, (result as { machine: Machine }).machine];
        return result;
      }
      case "local-terminal:machine-remove": machines = machines.filter((machine) => machine.name !== (payload as { name: string }).name); return { ok: true };
      case "local-terminal:ssh-login": return { status: "ready", id: "t9" };
      case "local-terminal:create": return { status: "ready", id: "vps/t5" };
      default: return { ok: true };
    }
  });
  window.operator = { invoke, on: () => () => undefined };
  return invoke;
}

const machinesList = () => screen.getByRole("list", { name: "Machines" });

describe("Terminal window ssh machines", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); window.localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("adds a machine by its ssh address and lists it", async () => {
    const invoke = installOperator({ add: ({ target, name }) => ({ ok: true, machine: { name: name ?? "10.0.0.7", target, state: "connected", temporary: false } }) });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: " can@10.0.0.7:2222 " } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "VPS" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:machine-add", { target: "can@10.0.0.7:2222", name: "vps" }));
    expect(await within(machinesList()).findByText("can@10.0.0.7:2222 · Connected")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Add machine" })).toBeNull();
  });

  it("refuses an address that is not one before asking the core", async () => {
    const invoke = installOperator();
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: "-oProxyCommand=sh" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText("Check the address: host, user@host or user@host:port.")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("local-terminal:machine-add", expect.anything());
  });

  it("offers a terminal running ssh when the host cannot be reached without the person", async () => {
    const invoke = installOperator({ add: () => ({ ok: false, reason: "unreachable" }) });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: "new-host" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText(/doesn't know this host's key yet/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open in terminal" }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:t9");
    expect(invoke).toHaveBeenCalledWith("local-terminal:ssh-login", { target: "new-host", cols: 100, rows: 30 });
  });

  it("shows a machine's terminals under it, starts a shell there, and forgets it", async () => {
    const invoke = installOperator({
      machines: [{ name: "vps", target: "can@10.0.0.7", state: "connected", temporary: false }],
      facts: [fact("t1", "local shell"), fact("vps/t4", "deploy")],
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Group by machine" }));
    const vps = await screen.findByRole("region", { name: "vps" });
    expect(within(vps).getByRole("button", { name: /deploy/ })).toBeTruthy();
    fireEvent.click(within(vps).getByRole("button", { name: /deploy/ }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:vps/t4");

    fireEvent.click(within(machinesList()).getByRole("button", { name: "New terminal on vps" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:create", { cols: 100, rows: 30, machine: "vps" }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("local:vps/t5");
    // Fault detected (Greptile, #3570): a running terminal on an added machine read as ended.
    expect(screen.queryByText(/ ended$/)).toBeNull();

    fireEvent.click(within(machinesList()).getByRole("button", { name: "Remove vps" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove machine" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:machine-remove", { name: "vps" }));
    await waitFor(() => expect(within(machinesList()).queryByText(/can@10.0.0.7/)).toBeNull());
  });

  it("offers to log in or dial again when a machine needs the person", async () => {
    const invoke = installOperator({ machines: [{ name: "lab", target: "me@lab", state: "needs_login", temporary: false }] });
    render(<TerminalWindowApp />);
    expect(await within(await screen.findByRole("list", { name: "Machines" })).findByText("me@lab · Needs login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:machine-connect", { name: "lab" }));
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Open in terminal" })); });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:ssh-login", { target: "me@lab", cols: 100, rows: 30 }));
  });
});
