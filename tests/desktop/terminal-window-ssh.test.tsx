// @vitest-environment jsdom

import React, { StrictMode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName }: { sessionName: string }) => <div data-testid="terminal-view">{sessionName}</div>,
}));

import TerminalWindowApp from "@desktop/renderer/src/features/terminal-window/TerminalWindowApp";
import { useSshMachines } from "@desktop/renderer/src/features/terminal-window/use-ssh-machines";

// Spec 2706 layer 7: add a machine reached over ssh from the sidebar, as in
// Herdr; its terminals show under it, and a host key or password only the
// person can answer is answered in a terminal running ssh.

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

type Machine = { name: string; target: string; state: string; temporary: boolean };
const fact = (id: string, title: string) => ({ id, title, status: null, statusAt: Date.now(), turn: 0, seenTurn: null, finished: false });

function installOperator(options: {
  peers?: unknown;
  machines?: Machine[]; add?: (payload: { target: string; name?: string }) => unknown; facts?: unknown[]; refuseRemove?: boolean; failList?: () => boolean; refuseLogin?: boolean; failUpdate?: string[]; changedUpdate?: string[]; unsupportedUpdate?: string[];
  holdInstall?: Promise<void>;
} = {}) {
  let machines = options.machines ?? [];
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      case "auth:status": return { signedIn: false, platformHost: "https://app.matrix-os.com", authGeneration: 0 };
      case "state:get": return { value: null };
      case "app:get-zoom": return { factor: 1 };
      case "local-terminal:watch": return { status: "ready", terminals: [...(options.facts ?? []), fact("vps/t5", "Terminal")] };
      case "local-terminal:machines": if (options.failList?.()) throw new Error("timed out"); return { status: "ready", machines };
      case "local-terminal:machine-add": {
        const result = options.add?.(payload as { target: string; name?: string }) ?? { ok: false, reason: "unavailable" };
        if ((result as { ok: boolean }).ok) machines = [...machines, (result as { machine: Machine }).machine];
        return result;
      }
      case "local-terminal:machine-remove":
        if (options.refuseRemove) return { ok: false };
        machines = machines.filter((machine) => machine.name !== (payload as { name: string }).name); return { ok: true };
      case "local-terminal:tailscale-peers": return options.peers ?? { status: "missing" };
      case "local-terminal:machine-login": return options.refuseLogin ? { status: "unavailable" } : { status: "ready", id: "t8" };
      case "local-terminal:machine-install": {
        await options.holdInstall;
        const { target, name } = payload as { target: string; name: string };
        machines = [...machines, { name, target, state: "connected", temporary: false }];
        return { ok: true };
      }
      case "local-terminal:machine-update": {
        const { name } = payload as { name: string };
        if (options.changedUpdate?.includes(name)) return { ok: false, reason: "changed" };
        if (options.unsupportedUpdate?.includes(name)) return { ok: false, reason: "unsupported" };
        return options.failUpdate?.includes(name) ? { ok: false, reason: "failed" } : { ok: true };
      }
      case "local-terminal:ssh-login": return options.refuseLogin ? { status: "unavailable" } : { status: "ready", id: "t9" };
      case "local-terminal:create": return { status: "ready", id: "vps/t5" };
      default: return { ok: true };
    }
  });
  const listeners: Array<(payload: unknown) => void> = [];
  window.operator = { invoke, on: (channel: string, callback: (payload: unknown) => void) => {
    if (channel === "window:focus-changed") listeners.push(callback);
    return () => undefined;
  } };
  return Object.assign(invoke, { focus: () => act(() => { for (const listener of listeners) listener({ focused: true }); }) });
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

  // Fault detected (Greptile, #3570): under StrictMode the dialog never closed after a finished add.
  it("closes after a successful add under StrictMode", async () => {
    installOperator({ add: ({ target }) => ({ ok: true, machine: { name: "box", target, state: "connected", temporary: false } }) });
    render(<StrictMode><TerminalWindowApp /></StrictMode>);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: "me@box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add machine" })).toBeNull());
  });

  // Fault detected (Greptile, #3570): the address could change while an add ran, mixing up its error.
  it("locks the fields while an add runs", async () => {
    let finish!: (value: unknown) => void;
    installOperator({ add: () => new Promise((resolve) => { finish = resolve; }) as never });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: "me@box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: "ssh address" }) as HTMLInputElement).disabled).toBe(true));
    await act(async () => { finish({ ok: false, reason: "unreachable" }); });
    expect((within(dialog).getByRole("textbox", { name: "ssh address" }) as HTMLInputElement).disabled).toBe(false);
  });

  it("refuses an address that is not one before asking the core", async () => {
    const invoke = installOperator();
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: "-oProxyCommand=sh" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText(/Check the address/)).toBeTruthy();
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

  // Fault detected (Greptile, #3570): a refused removal closed the dialog and said nothing.
  it("keeps the remove dialog open with an error when the core refuses", async () => {
    installOperator({ machines: [{ name: "vps", target: "can@10.0.0.7", state: "connected", temporary: false }], refuseRemove: true });
    render(<TerminalWindowApp />);
    fireEvent.click(await within(await screen.findByRole("list", { name: "Machines" })).findByRole("button", { name: "Remove vps" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove machine" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByText("Couldn't remove it. Try again.")).toBeTruthy();
    expect(within(machinesList()).getByText("can@10.0.0.7 · Connected")).toBeTruthy();
  });

  // Fault detected (Greptile, #3570): one failed look hid every machine until the window was refocused.
  it("keeps the machines listed when a later look fails", async () => {
    let fail = false;
    const invoke = installOperator({ machines: [{ name: "vps", target: "can@10.0.0.7", state: "connected", temporary: false }], failList: () => fail });
    render(<TerminalWindowApp />);
    expect(await within(await screen.findByRole("list", { name: "Machines" })).findByText("can@10.0.0.7 · Connected")).toBeTruthy();
    fail = true;
    invoke.focus();
    await waitFor(() => expect(invoke.mock.calls.filter(([channel]) => channel === "local-terminal:machines").length).toBeGreaterThan(1));
    expect(within(machinesList()).getByText("can@10.0.0.7 · Connected")).toBeTruthy();
  });

  // Fault detected (Greptile, #3570): a login terminal that could not start said nothing.
  it("says so when the ssh login terminal cannot start", async () => {
    installOperator({ machines: [{ name: "lab", target: "me@lab", state: "unreachable", temporary: false }], refuseLogin: true });
    render(<TerminalWindowApp />);
    fireEvent.click(await within(await screen.findByRole("list", { name: "Machines" })).findByRole("button", { name: "Open in terminal" }));
    expect(await within(machinesList()).findByText("Couldn't open a terminal. Try again.")).toBeTruthy();
  });

  // Fault detected (Greptile, #3570): an add still running when the dialog closed closed the next one.
  it("does not let an earlier add close a reopened dialog", async () => {
    let finish!: (value: unknown) => void;
    installOperator({ add: () => new Promise((resolve) => { finish = resolve; }) as never });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    let dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: "slow-host" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add machine…" }));
    dialog = await screen.findByRole("dialog", { name: "Add machine" });
    await act(async () => { finish({ ok: true, machine: { name: "slow-host", target: "slow-host", state: "connected", temporary: false } }); });
    expect(screen.getByRole("dialog", { name: "Add machine" })).toBeTruthy();
  });

  // Hamed, 2026-11-22: custom ssh options and Tailscale peers in one click.
  it("adds with a port, identity file and jump host as fields, never as a command", async () => {
    const invoke = installOperator({ add: ({ target }) => ({ ok: true, machine: { name: "box", target, state: "connected", temporary: false } }) });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: "me@box" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Port" }), { target: { value: "2222" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Identity file" }), { target: { value: "~/.ssh/id_box" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Jump host" }), { target: { value: "me@bastion" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:machine-add", {
      target: "me@box", ssh: { port: 2222, identity: "~/.ssh/id_box", jump: "me@bastion" },
    }));
  });

  it("refuses an identity file that could become an option", async () => {
    const invoke = installOperator();
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: "me@box" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Identity file" }), { target: { value: "-oProxyCommand=sh" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText(/Check the address/)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("local-terminal:machine-add", expect.anything());
  });

  it("lists tailnet peers and adds one in one click, with Tailscale SSH when it offers it", async () => {
    const invoke = installOperator({
      peers: { status: "ready", peers: [{ name: "Build Box", dnsName: "build-box.tail.ts.net", os: "linux", online: true, tailscaleSsh: true }] },
      add: ({ target }) => ({ ok: true, machine: { name: "build-box", target, state: "connected", temporary: false } }),
    });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add Build Box" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:machine-add", {
      target: "build-box.tail.ts.net", name: "build-box", ssh: { tailscaleSsh: true },
    }));
  });

  it("says when Tailscale is logged out instead of listing peers", async () => {
    installOperator({ peers: { status: "logged-out" } });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    expect(await within(await screen.findByRole("dialog", { name: "Add machine" })).findByText("Tailscale is logged out on this Mac.")).toBeTruthy();
  });

  // Spec 2706 layer 8: install and keep current the app's core on added machines.
  it("installs the app's core on a machine that has none", async () => {
    const invoke = installOperator({ add: () => ({ ok: false, reason: "hc_missing" }) });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: "me@fresh-box:2222" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Install core there" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:machine-install", { target: "me@fresh-box:2222", name: "fresh-box" }));
    expect(await within(machinesList()).findByText(/me@fresh-box:2222 · Connected/)).toBeTruthy();
  });

  // Fault detected (Greptile, #3579): the form took another Add while an install ran, and lost its result.
  it("holds the form while the core installs", async () => {
    let finish: () => void = () => undefined;
    const invoke = installOperator({ add: () => ({ ok: false, reason: "hc_missing" }), holdInstall: new Promise<void>((resolve) => { finish = resolve; }) });
    render(<TerminalWindowApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Add machine…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ssh address" }), { target: { value: "me@fresh-box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Install core there" }));
    expect(await within(dialog).findByRole("button", { name: "Installing…" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("textbox", { name: "ssh address" }).hasAttribute("disabled")).toBe(true);
    fireEvent.submit(within(dialog).getByRole("button", { name: "Add" }).closest("form")!);
    expect(invoke.mock.calls.filter(([channel]) => channel === "local-terminal:machine-add")).toHaveLength(1);
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add machine" })).toBeNull());
  });

  // Review on #3579: an update refused because the name now belongs to another machine says so.
  it("says when an update was refused because the name now belongs to a different machine", async () => {
    installOperator({ changedUpdate: ["vps"], machines: [{ name: "vps", target: "can@10.0.0.7", state: "connected", temporary: false, version: "0.1.14" } as never] });
    render(<TerminalWindowApp />);
    const machines = await screen.findByRole("list", { name: "Machines" });
    fireEvent.click(await within(machines).findByRole("button", { name: "Update core" }));
    expect(await within(machines).findByText("Not updated: this name now belongs to a different machine. Check it, then try again.")).toBeTruthy();
  });

  // Nima, #3579/#3662: a Windows target is refused with a clear reason, not a generic failure.
  it("says when a machine's core cannot be updated from here", async () => {
    installOperator({ unsupportedUpdate: ["win"], machines: [{ name: "win", target: "me@winbox", state: "connected", temporary: false, version: "0.1.14" } as never] });
    render(<TerminalWindowApp />);
    const machines = await screen.findByRole("list", { name: "Machines" });
    fireEvent.click(await within(machines).findByRole("button", { name: "Update core" }));
    expect(await within(machines).findByText("Not updated: the app can't update the core on this machine (Windows). Update it there.")).toBeTruthy();
  });

  it("shows a machine's core version and updates an older one", async () => {
    const invoke = installOperator({ machines: [{ name: "vps", target: "can@10.0.0.7", state: "connected", temporary: false, version: "0.1.14" } as never] });
    render(<TerminalWindowApp />);
    const machines = await screen.findByRole("list", { name: "Machines" });
    expect(await within(machines).findByText("can@10.0.0.7 · Connected · core 0.1.14")).toBeTruthy();
    const update = within(machines).getByRole("button", { name: "Update core" });
    // Fault detected (Greptile, #3579): a hand-styled native button; it is the shared Button now.
    expect(update.classList.contains("matrix-btn")).toBe(true);
    fireEvent.click(update);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:machine-update", { name: "vps", target: "can@10.0.0.7" }));
  });

  // Fault detected (Greptile, #3579): one machine's success cleared another's update error, and a dropped line hid it.
  it("keeps each machine's core update error, also while its line is down", async () => {
    installOperator({
      failUpdate: ["one"],
      machines: [
        { name: "one", target: "me@one", state: "unreachable", temporary: false, version: "0.1.14" },
        { name: "two", target: "me@two", state: "connected", temporary: false, version: "0.1.14" },
      ] as never,
    });
    render(<TerminalWindowApp />);
    const machines = await screen.findByRole("list", { name: "Machines" });
    const updates = await within(machines).findAllByRole("button", { name: "Update core" });
    fireEvent.click(updates[0]!);
    expect(await within(machines).findByText("Couldn't update its core.")).toBeTruthy();
    fireEvent.click(within(machines).getByRole("button", { name: "Update core" }));
    await waitFor(() => expect(within(machines).getAllByText("Couldn't update its core.")).toHaveLength(1));
    expect(within(machines).getByRole("button", { name: "Open in terminal" })).toBeTruthy();
  });

  // Fault detected (Greptile, #3579): a removed machine's update error came back on another machine that took its name.
  it("forgets a machine's core update error once it is removed", async () => {
    installOperator({ failUpdate: ["vps"], machines: [{ name: "vps", target: "me@old", state: "connected", temporary: false }] });
    const { result } = renderHook(() => useSshMachines());
    await act(async () => { await result.current.update({ name: "vps", target: "me@old", state: "connected", temporary: false }); });
    expect(result.current.coreFailed).toEqual(["vps"]);
    await act(async () => { await result.current.remove("vps"); });
    expect(result.current.coreFailed).toEqual([]);
  });

  it("offers to log in or dial again when a machine needs the person", async () => {
    const invoke = installOperator({ machines: [{ name: "lab", target: "me@lab", state: "needs_login", temporary: false }] });
    render(<TerminalWindowApp />);
    expect(await within(await screen.findByRole("list", { name: "Machines" })).findByText("me@lab · Needs login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:machine-connect", { name: "lab" }));
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Open in terminal" })); });
    // Fault detected (Greptile, #3570): a machine added with custom ssh got a plain ssh terminal; it now goes by name.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-terminal:machine-login", { name: "lab", cols: 100, rows: 30 }));
  });
});
