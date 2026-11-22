// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OwnedComputerSummary } from "../../packages/contracts/src/index.js";
import { matrixComputerAvailabilityLabel, MatrixComputerListSchema } from "../../packages/contracts/src/index.js";
import { OwnedComputersPanel } from "../../packages/ui/src/owned-computers/OwnedComputersPanel";
import {
  OWNED_COMPUTER_INSTALL_COMMAND,
  createOwnedComputersClient,
  ownedComputerLastSeenLabel,
  ownedComputerPlatformLabel,
  ownedComputerStatusLabel,
  ownedComputersAtLimit,
  type OwnedComputersTransport,
} from "../../packages/ui/src/owned-computers/owned-computers-model";

const ID_A = "4f7c2d1e-5a6b-4c3d-8e9f-0a1b2c3d4e5f";
const ID_B = "5f7c2d1e-5a6b-4c3d-8e9f-0a1b2c3d4e5f";
const ID_C = "6f7c2d1e-5a6b-4c3d-8e9f-0a1b2c3d4e5f";

function computer(overrides: Partial<OwnedComputerSummary> = {}): OwnedComputerSummary {
  return {
    machineId: ID_A,
    handle: "alice",
    runtimeSlot: "owned-0a1b2c3d",
    name: "Lab server",
    status: "online",
    lastSeenAt: new Date(Date.now() - 14 * 60_000).toISOString(),
    os: "Ubuntu 24.04",
    arch: "x86_64",
    agentVersion: "1.2.3",
    autoSecurityUpdates: true,
    backupsEnabled: false,
    ...overrides,
  };
}

function transport(computers: OwnedComputerSummary[]) {
  const t = {
    get: vi.fn<OwnedComputersTransport["get"]>(async () => ({ computers, limit: 3 })),
    patch: vi.fn<OwnedComputersTransport["patch"]>(async (_path, body) => ({ ...computers[0]!, ...(body as object) })),
    remove: vi.fn<OwnedComputersTransport["remove"]>(async () => undefined),
  };
  return t;
}

beforeAll(() => {
  // jsdom lacks the native dialog modal API used by the shared Dialog.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("owned computers model", () => {
  const now = new Date("2026-11-22T10:00:00.000Z");
  it("derives status, last seen and platform labels", () => {
    expect(ownedComputerStatusLabel("online")).toBe("Online");
    expect(ownedComputerStatusLabel("offline")).toBe("Offline");
    expect(ownedComputerStatusLabel("enrolling")).toBe("Connecting");
    expect(ownedComputerLastSeenLabel(null, now)).toBe("Not connected yet");
    expect(ownedComputerLastSeenLabel("2026-11-22T09:59:40.000Z", now)).toBe("Last seen just now");
    expect(ownedComputerLastSeenLabel("2026-11-22T09:46:00.000Z", now)).toBe("Last seen 14 min ago");
    expect(ownedComputerLastSeenLabel("2026-11-22T07:00:00.000Z", now)).toBe("Last seen 3 h ago");
    expect(ownedComputerLastSeenLabel("2026-11-20T10:00:00.000Z", now)).toBe("Last seen 2 days ago");
    expect(ownedComputerPlatformLabel(computer())).toBe("Ubuntu 24.04 · x86_64 · v1.2.3");
  });

  it("reports the limit and rejects malformed server data", async () => {
    expect(ownedComputersAtLimit({ computers: [computer(), computer({ machineId: ID_B }), computer({ machineId: ID_C })], limit: 3 })).toBe(true);
    expect(ownedComputersAtLimit({ computers: [computer()], limit: 3 })).toBe(false);
    const bad = transport([]);
    bad.get.mockResolvedValue({ computers: [{ machineId: "x" }], limit: 3 });
    await expect(createOwnedComputersClient(bad).list()).rejects.toThrow();
    await expect(createOwnedComputersClient(bad).remove("../etc")).rejects.toThrow();
    expect(bad.remove).not.toHaveBeenCalled();
  });

  it("labels an unreachable owned computer as offline in the computer switcher", () => {
    expect(matrixComputerAvailabilityLabel({ kind: "owned", availability: "unavailable" })).toBe("Offline");
    expect(matrixComputerAvailabilityLabel({ kind: "owned", availability: "starting" })).toBe("Connecting");
    expect(matrixComputerAvailabilityLabel({ kind: "customer", availability: "unavailable" })).toBe("Unavailable");
    const list = MatrixComputerListSchema.parse({
      items: [{ handle: "alice", runtimeSlot: "owned-0a1b2c3d", label: "Own Computer", availability: "unavailable", kind: "owned", gatewayPath: "/vm/alice?runtime=owned-0a1b2c3d", capabilities: [] }],
      hasMore: false, limit: 20, selectedSlot: null,
    });
    expect(list.items[0]?.kind).toBe("owned");
  });
});

describe("OwnedComputersPanel", () => {
  it("lists computers with status, last seen and platform", async () => {
    render(<OwnedComputersPanel scope="a" transport={transport([computer(), computer({ machineId: ID_B, name: "Old laptop", status: "offline" })])} />);
    const list = await screen.findByRole("list", { name: "Connected computers" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Lab server")).toBeTruthy();
    expect(within(rows[0]!).getByText("Online")).toBeTruthy();
    expect(within(rows[0]!).getByText(/Last seen 14 min ago · Ubuntu 24.04 · x86_64 · v1.2.3/)).toBeTruthy();
    expect(within(rows[1]!).getByText("Offline")).toBeTruthy();
  });

  it("renames inline and saves through the transport", async () => {
    const t = transport([computer()]);
    render(<OwnedComputersPanel scope="a" transport={t} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename Lab server" }));
    const input = screen.getByRole("textbox", { name: "Computer name" });
    fireEvent.change(input, { target: { value: "Garage box" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Garage box");
    expect(t.patch).toHaveBeenCalledWith(`/api/auth/owned-computers/${ID_A}`, { name: "Garage box" });
  });

  it("toggles backups and security updates", async () => {
    const t = transport([computer()]);
    render(<OwnedComputersPanel scope="a" transport={t} />);
    const backups = await screen.findByRole("switch", { name: "Back up Lab server to Matrix" });
    expect(backups.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Automatic security updates for Lab server" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(backups);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Back up Lab server to Matrix" }).getAttribute("aria-checked")).toBe("true"));
    expect(t.patch).toHaveBeenCalledWith(`/api/auth/owned-computers/${ID_A}`, { backupsEnabled: true });
  });

  it("removes a computer only after confirmation and server success", async () => {
    const t = transport([computer()]);
    render(<OwnedComputersPanel scope="a" transport={t} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Lab server" }));
    expect(screen.getByText(/Files and data stay on the machine itself/)).toBeTruthy();
    expect(t.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("Lab server")).toBeNull());
    expect(t.remove).toHaveBeenCalledWith(`/api/auth/owned-computers/${ID_A}`);
  });

  it("keeps the row and shows generic copy when removal fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = transport([computer()]);
    t.remove.mockRejectedValue(new Error("pg: relation owned_machine_links timeout"));
    render(<OwnedComputersPanel scope="a" transport={t} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Lab server" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The computer could not be removed. It is still connected.");
    expect(screen.getByText("Lab server")).toBeTruthy();
    expect(screen.queryByText(/pg:/)).toBeNull();
  });

  it("shows an onboarding empty state with the install command", async () => {
    render(<OwnedComputersPanel scope="a" transport={transport([])} />);
    expect(await screen.findByRole("heading", { name: "Use your own computer, free" })).toBeTruthy();
    expect(screen.getByText(OWNED_COMPUTER_INSTALL_COMMAND)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy install command" })).toBeTruthy();
  });

  it("disables adding at the limit and explains why", async () => {
    render(<OwnedComputersPanel scope="a" transport={transport([computer(), computer({ machineId: ID_B }), computer({ machineId: ID_C })])} />);
    const add = await screen.findByRole("button", { name: "Add a computer" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/You can connect up to 3 of your own computers/)).toBeTruthy();
  });

  it("shows the install command when adding below the limit", async () => {
    render(<OwnedComputersPanel scope="a" transport={transport([computer()])} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a computer" }));
    expect(screen.getByText(OWNED_COMPUTER_INSTALL_COMMAND)).toBeTruthy();
  });

  it("offers a retry when the list cannot load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = transport([computer()]);
    t.get.mockRejectedValueOnce(new Error("down"));
    render(<OwnedComputersPanel scope="a" transport={t} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Lab server")).toBeTruthy();
  });

  it("keeps other rows usable while one update is pending and ignores a stale reply", async () => {
    const t = transport([computer(), computer({ machineId: ID_B, name: "Old laptop" })]);
    const replies: Array<(value: unknown) => void> = [];
    t.patch.mockImplementation(() => new Promise((resolve) => { replies.push(resolve); }));
    render(<OwnedComputersPanel scope="a" transport={t} />);
    const backupsA = await screen.findByRole("switch", { name: "Back up Lab server to Matrix" });
    fireEvent.click(backupsA);
    const backupsB = screen.getByRole("switch", { name: "Back up Old laptop to Matrix" });
    expect((backupsB as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("switch", { name: "Back up Lab server to Matrix" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(backupsB);
    replies[1]!(computer({ machineId: ID_B, name: "Old laptop", backupsEnabled: true }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Back up Old laptop to Matrix" }).getAttribute("aria-checked")).toBe("true"));
    expect((screen.getByRole("switch", { name: "Back up Lab server to Matrix" }) as HTMLButtonElement).disabled).toBe(true);
    replies[0]!(computer({ backupsEnabled: true }));
    await waitFor(() => expect((screen.getByRole("switch", { name: "Back up Lab server to Matrix" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("drops a reply that a newer list refresh already superseded", async () => {
    const t = transport([computer()]);
    let resolvePatch: (value: unknown) => void = () => undefined;
    t.patch.mockImplementation(() => new Promise((resolve) => { resolvePatch = resolve; }));
    render(<OwnedComputersPanel scope="a" transport={t} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Back up Lab server to Matrix" }));
    t.get.mockResolvedValue({ computers: [computer({ name: "Renamed elsewhere", backupsEnabled: true })], limit: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Renamed elsewhere");
    resolvePatch(computer({ name: "Lab server", backupsEnabled: false }));
    await waitFor(() => expect((screen.getByRole("switch", { name: "Back up Renamed elsewhere to Matrix" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("Renamed elsewhere")).toBeTruthy();
  });

  it("refreshes the list on an interval so status changes appear", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = transport([computer()]);
      render(<OwnedComputersPanel scope="a" transport={t} />);
      expect(await screen.findByText("Online")).toBeTruthy();
      t.get.mockResolvedValue({ computers: [computer({ status: "offline" })], limit: 3 });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await screen.findByText("Offline")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an abort signal to list loads", async () => {
    const t = transport([computer()]);
    const { unmount } = render(<OwnedComputersPanel scope="a" transport={t} />);
    await screen.findByText("Lab server");
    const signal = (t.get.mock.calls[0] as unknown[])[1] as { signal?: AbortSignal } | undefined;
    expect(signal?.signal).toBeInstanceOf(AbortSignal);
    unmount();
    expect(signal?.signal?.aborted).toBe(true);
  });
});

describe("owned computers settings availability", () => {
  it("manages computers on hosted and enrolled owned computers but not on standalone self-host", async () => {
    const { ownedComputersAvailability } = await import("../../packages/ui/src/owned-computers/owned-computers-model");
    expect(ownedComputersAvailability({ selfHosted: false, substrate: null })).toBe("manage");
    expect(ownedComputersAvailability({ selfHosted: true, substrate: "owned" })).toBe("manage");
    expect(ownedComputersAvailability({ selfHosted: true, substrate: null })).toBe("hosted-account");
  });
});
