// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrivateNetworkPanel } from "../../packages/ui/src/private-network/PrivateNetworkPanel";
import { MACHINES_IDLE_POLL_MS, STATUS_IDLE_POLL_MS } from "../../packages/ui/src/private-network/presentation";
import type {
  PairedMachinesResponse,
  PrivateNetworkClient,
  PrivateNetworkStatus,
} from "../../packages/ui/src/private-network/client";

const LEAK = "tailscaled: dial unix /var/run/tailscale/tailscaled.sock: secret-path";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function status(overrides: Partial<PrivateNetworkStatus> = {}): PrivateNetworkStatus {
  return {
    supported: true,
    accessMode: "tailscale",
    state: "logged-out",
    loginUrl: null,
    tailnet: null,
    machine: null,
    viaPrivateNetwork: false,
    ...overrides,
  };
}

const connected = status({
  state: "connected",
  tailnet: "alice@example.com",
  machine: { name: "box", dnsName: "box.tail1234.ts.net", url: "https://box.tail1234.ts.net" },
});

const machineList: PairedMachinesResponse = {
  revision: 4,
  machines: [
    {
      id: "0123456789abcdef0123456789abcdef",
      name: "studio",
      dnsName: "studio.tail1234.ts.net",
      url: "https://studio.tail1234.ts.net",
      pairedAt: "2026-11-01T12:00:00Z",
      online: true,
    },
  ],
};

function fakeClient(overrides: Partial<PrivateNetworkClient> = {}): PrivateNetworkClient {
  return {
    status: vi.fn(async () => status()),
    connect: vi.fn(async () => status()),
    disconnect: vi.fn(async () => status({ state: "stopped" })),
    machines: vi.fn(async () => ({ revision: 1, machines: [] })),
    createJoinCode: vi.fn(async () => ({ code: "x", command: "", expiresAt: new Date().toISOString() })),
    removeMachine: vi.fn(async () => ({ revision: 5, machines: [] })),
    ...overrides,
  };
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("PrivateNetworkPanel", () => {
  it("renders nothing on managed computers", async () => {
    const client = fakeClient({ status: vi.fn(async () => status({ supported: false, state: "unsupported" })) });
    const { container } = render(<PrivateNetworkPanel client={client} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the gateway does not have the route", async () => {
    const client = fakeClient({
      status: vi.fn(async () => {
        throw Object.assign(new Error(LEAK), { httpStatus: 404 });
      }),
    });
    const { container } = render(<PrivateNetworkPanel client={client} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("explains how to install Tailscale when it is missing", async () => {
    const client = fakeClient({ status: vi.fn(async () => status({ state: "not-installed" })) });
    render(<PrivateNetworkPanel client={client} />);
    expect(await screen.findByText(/--access tailscale/)).toBeTruthy();
  });

  it("connects, shows the login link, and polls until connected", async () => {
    vi.useFakeTimers();
    const loginUrl = "https://login.tailscale.com/a/abc123";
    const statusMock = vi
      .fn<PrivateNetworkClient["status"]>()
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({ state: "needs-login", loginUrl }))
      .mockResolvedValueOnce(connected);
    const client = fakeClient({
      status: statusMock,
      connect: vi.fn(async () => status({ state: "needs-login", loginUrl })),
      machines: vi.fn(async () => machineList),
    });
    render(<PrivateNetworkPanel client={client} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await flush();
    const login = screen.getByRole("link", { name: "Open login page" });
    expect(login.getAttribute("href")).toBe(loginUrl);
    expect(login.getAttribute("target")).toBe("_blank");
    expect(login.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(/Waiting for you to finish signing in/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy login link" })).toBeTruthy();

    await flush(3_000);
    expect(statusMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("link", { name: "Open login page" })).toBeTruthy();
    await flush(3_000);
    expect(statusMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.getByRole("link", { name: "box.tail1234.ts.net" }).getAttribute("href")).toBe("https://box.tail1234.ts.net");
    await flush(10_000);
    expect(statusMock).toHaveBeenCalledTimes(3);
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    const statusMock = vi.fn(async () => status({ state: "needs-login", loginUrl: "https://login.tailscale.com/a/x" }));
    const client = fakeClient({ status: statusMock });
    const view = render(<PrivateNetworkPanel client={client} />);
    await flush();
    view.unmount();
    await flush(30_000);
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation to disconnect and warns when reached over the private network", async () => {
    const disconnect = vi.fn(async () => status({ state: "stopped", viaPrivateNetwork: true }));
    const client = fakeClient({
      status: vi.fn(async () => ({ ...connected, viaPrivateNetwork: true })),
      machines: vi.fn(async () => machineList),
      disconnect,
    });
    render(<PrivateNetworkPanel client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(within(dialog).getByText(/sudo tailscale up/)).toBeTruthy();
    expect(within(dialog).getByText(/reached over the private network/i)).toBeTruthy();
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect", hidden: true }));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("keeps the connected state and shows a generic error when disconnect fails", async () => {
    const client = fakeClient({
      status: vi.fn(async () => connected),
      machines: vi.fn(async () => machineList),
      disconnect: vi.fn(async () => {
        throw new Error(LEAK);
      }),
    });
    render(<PrivateNetworkPanel client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(within(dialog).queryByText(/sudo tailscale up/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect", hidden: true }));
    expect(await screen.findByText("Could not disconnect. Try again.")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret-path");
  });

  it("keeps this computer's connection status current after it connects", async () => {
    // Found in review: polling stopped once connected, so a disconnect elsewhere
    // (another tab, or tailscale down on the server) kept showing Connected.
    vi.useFakeTimers();
    const statusFn = vi.fn<PrivateNetworkClient["status"]>().mockResolvedValueOnce(connected).mockResolvedValue(status({ state: "stopped" }));
    render(<PrivateNetworkPanel client={fakeClient({ status: statusFn })} />);
    await flush();
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
    await flush(STATUS_IDLE_POLL_MS);
    expect(statusFn).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Disconnected").length).toBeGreaterThan(0);
  });

  it("keeps paired machines' online state current without a join code", async () => {
    // Found in review: the list refreshed only while a join code was active,
    // so a machine that went offline kept showing Online.
    vi.useFakeTimers();
    const offline = { ...machineList, machines: machineList.machines.map((machine) => ({ ...machine, online: false })) };
    const machines = vi
      .fn<PrivateNetworkClient["machines"]>()
      .mockResolvedValueOnce(machineList)
      .mockResolvedValue(offline);
    render(<PrivateNetworkPanel client={fakeClient({ status: vi.fn(async () => connected), machines })} />);
    await flush();
    expect(screen.getByText("Online")).toBeTruthy();
    await flush(MACHINES_IDLE_POLL_MS);
    expect(machines).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Online")).toBeNull();
  });

  it("adds a machine with a copyable command and expiry, then lists the paired machine", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-21T10:00:00Z"));
    const machines = vi
      .fn<PrivateNetworkClient["machines"]>()
      .mockResolvedValueOnce({ revision: 1, machines: [] })
      .mockResolvedValue(machineList);
    const command = "curl -fsSL https://matrix-os.com/install | sh -s -- --join ABCD-1234";
    const client = fakeClient({
      status: vi.fn(async () => connected),
      machines,
      createJoinCode: vi.fn(async () => ({ code: "ABCD-1234", command, expiresAt: "2026-11-21T10:15:00Z" })),
    });
    render(<PrivateNetworkPanel client={client} />);
    await flush();
    expect(screen.getByText("No other machines yet")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Add a machine" })[0]!);
    await flush();
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.getByText("Expires in 15 min")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(screen.getByText(/same Tailscale account/)).toBeTruthy();
    await flush(5_000);
    expect(machines).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("link", { name: "studio.tail1234.ts.net" })).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("removes a machine with its id and the last list revision", async () => {
    const removeMachine = vi.fn(async () => ({ revision: 5, machines: [] }));
    const client = fakeClient({
      status: vi.fn(async () => connected),
      machines: vi.fn(async () => machineList),
      removeMachine,
    });
    render(<PrivateNetworkPanel client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove studio" }));
    expect(removeMachine).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { hidden: true });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove", hidden: true }));
    expect(removeMachine).toHaveBeenCalledWith("0123456789abcdef0123456789abcdef", 4, expect.any(AbortSignal));
    expect(await screen.findByText("No other machines yet")).toBeTruthy();
  });

  it("offers a new join code once the previous one expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-21T10:00:00Z"));
    const createJoinCode = vi
      .fn<PrivateNetworkClient["createJoinCode"]>()
      .mockResolvedValueOnce({ code: "ABCD-1234", command: "first-command", expiresAt: "2026-11-21T10:01:00Z" })
      .mockResolvedValueOnce({ code: "EFGH-5678", command: "second-command", expiresAt: "2026-11-21T10:20:00Z" });
    const client = fakeClient({ status: vi.fn(async () => connected), createJoinCode });
    render(<PrivateNetworkPanel client={client} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Add a machine" }));
    await flush();
    expect(screen.getByText("first-command")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a machine" })).toBeNull();
    // Polls are chained, so step through each 5 s poll.
    for (let tick = 0; tick < 13; tick += 1) await flush(5_000);
    expect(screen.getByText("Expired")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a machine" }));
    await flush();
    expect(createJoinCode).toHaveBeenCalledTimes(2);
    expect(screen.getByText("second-command")).toBeTruthy();
  });

  it("reloads the list after a removal conflict so a retry sends the current revision", async () => {
    const machines = vi
      .fn<PrivateNetworkClient["machines"]>()
      .mockResolvedValueOnce(machineList)
      .mockResolvedValue({ ...machineList, revision: 6 });
    const removeMachine = vi
      .fn<PrivateNetworkClient["removeMachine"]>()
      .mockRejectedValueOnce(Object.assign(new Error(LEAK), { status: 409 }))
      .mockResolvedValueOnce({ revision: 7, machines: [] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = fakeClient({ status: vi.fn(async () => connected), machines, removeMachine });
    render(<PrivateNetworkPanel client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove studio" }));
    fireEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: "Remove", hidden: true }));
    expect(await screen.findByText("The machine list changed. Check it and try again.")).toBeTruthy();
    await act(async () => {});
    expect(machines).toHaveBeenCalledTimes(2);
    expect(screen.getByText("The machine list changed. Check it and try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove studio" }));
    fireEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: "Remove", hidden: true }));
    expect(removeMachine).toHaveBeenLastCalledWith("0123456789abcdef0123456789abcdef", 6, expect.any(AbortSignal));
    expect(await screen.findByText("No other machines yet")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret-path");
  });

  it("ignores a slow list read that finishes after a removal returned a newer revision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-21T10:00:00Z"));
    let resolveSlow: (value: PairedMachinesResponse) => void = () => undefined;
    const machines = vi
      .fn<PrivateNetworkClient["machines"]>()
      .mockResolvedValueOnce(machineList)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSlow = resolve;
      }))
      .mockResolvedValue({ revision: 5, machines: [] });
    const client = fakeClient({
      status: vi.fn(async () => connected),
      machines,
      createJoinCode: vi.fn(async () => ({ code: "ABCD-1234", command: "join", expiresAt: "2026-11-21T10:15:00Z" })),
      removeMachine: vi.fn(async () => ({ revision: 5, machines: [] })),
    });
    render(<PrivateNetworkPanel client={client} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Add a machine" }));
    await flush();
    await flush(5_000);
    expect(machines).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove studio" }));
    fireEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: "Remove", hidden: true }));
    await flush();
    expect(screen.getByText("No other machines yet")).toBeTruthy();
    await act(async () => {
      resolveSlow(machineList);
    });
    await flush();
    expect(screen.queryByText("studio")).toBeNull();
    expect(screen.getByText("No other machines yet")).toBeTruthy();
  });

  it("waits for a slow machine-list read instead of aborting it on the next poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-21T10:00:00Z"));
    const aborted: boolean[] = [];
    const machines = vi
      .fn<PrivateNetworkClient["machines"]>()
      .mockResolvedValueOnce({ revision: 1, machines: [] })
      .mockImplementationOnce((signal) => new Promise((resolve) => {
        // The gateway can wait on `tailscale status` for up to 10 s.
        setTimeout(() => {
          aborted.push(signal.aborted);
          resolve(machineList);
        }, 6_000);
      }))
      .mockResolvedValue(machineList);
    const client = fakeClient({
      status: vi.fn(async () => connected),
      machines,
      createJoinCode: vi.fn(async () => ({ code: "ABCD-1234", command: "join", expiresAt: "2026-11-21T10:15:00Z" })),
    });
    render(<PrivateNetworkPanel client={client} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Add a machine" }));
    await flush();
    await flush(5_000);
    expect(machines).toHaveBeenCalledTimes(2);
    await flush(5_000);
    // No new read while the slow one is still running.
    expect(machines).toHaveBeenCalledTimes(2);
    await flush(1_000);
    expect(aborted).toEqual([false]);
    expect(screen.getByText("studio")).toBeTruthy();
    // The next poll is scheduled only after the slow read settled.
    await flush(4_000);
    expect(machines).toHaveBeenCalledTimes(2);
    await flush(1_000);
    expect(machines).toHaveBeenCalledTimes(3);
  });

  it("never renders server error text", async () => {
    const client = fakeClient({
      status: vi.fn(async () => connected),
      machines: vi.fn(async () => machineList),
      removeMachine: vi.fn(async () => {
        throw new Error(LEAK);
      }),
      createJoinCode: vi.fn(async () => {
        throw new Error(LEAK);
      }),
    });
    render(<PrivateNetworkPanel client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove studio" }));
    fireEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: "Remove", hidden: true }));
    expect(await screen.findByText("Could not remove the machine. Try again.")).toBeTruthy();
    expect(screen.getByText("studio")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a machine" }));
    expect(await screen.findByText("Could not create a join code. Try again.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret-path");
  });

  it("shows a generic retryable error when status cannot load", async () => {
    const statusMock = vi
      .fn<PrivateNetworkClient["status"]>()
      .mockRejectedValueOnce(Object.assign(new Error(LEAK), { status: 502 }))
      .mockResolvedValueOnce(status({ state: "unavailable" }))
      .mockResolvedValueOnce(connected);
    const client = fakeClient({ status: statusMock, machines: vi.fn(async () => machineList) });
    render(<PrivateNetworkPanel client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/did not respond/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("alice@example.com")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret-path");
  });
});
