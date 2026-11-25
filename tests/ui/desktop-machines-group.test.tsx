// @vitest-environment jsdom
// The desktops group (spec 2716) every Terminal view shows: hidden without a linked
// desktop, each desktop's terminals and presets when it is online, last seen when it is
// not, and removal only after a confirmation that says what it does.
import React from "react";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPairingRevisionTag } from "@matrix-os/contracts";
import { desktopLinkWorkspaceId } from "@matrix-os/contracts/desktop-link";
import { DesktopMachinesGroup } from "../../packages/ui/src/desktop-link/DesktopMachinesGroup";
import { desktopTerminalRefKey, type DesktopLinkRequest } from "../../packages/ui/src/desktop-link/desktop-link-client";
import { useDesktopMachines } from "../../packages/ui/src/desktop-link/use-desktop-machines";

afterEach(cleanup);

const MACHINE = "6f1c2b8e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const MAC = "a".repeat(64);
const tab = `tt_${"1".repeat(32)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
// The one desktop paired with this computer (2698).
const machines = {
  machineId: MACHINE,
  machines: [
    { deviceId: MAC, name: "Hamed's MacBook Pro", revision: 2, state: "online", lastSeenAt: "2026-11-24T10:00:00.000Z" },
  ],
};
const offline = { machineId: MACHINE, machines: [{ ...machines.machines[0]!, state: "offline", lastSeenAt: "2026-11-24T09:46:00.000Z" }] };

function gateway(overrides: Partial<Record<string, (init: Parameters<DesktopLinkRequest>[1]) => Response>> = {}) {
  const calls: Array<{ path: string; init: Parameters<DesktopLinkRequest>[1] }> = [];
  const request: DesktopLinkRequest = vi.fn(async (path, init) => {
    calls.push({ path, init });
    const key = `${init.method} ${path}`;
    const override = overrides[key];
    if (override) return override(init);
    if (key === "GET /api/desktop-link/machines") return json(machines);
    if (key === `GET /api/desktop-link/machines/${MAC}/terminals`) {
      return json({ deviceId: MAC, workspaceId: desktopLinkWorkspaceId(MAC), sessions: [{ id: "t1", tabId: tab, title: "claude", status: "working" }] });
    }
    if (key === `POST /api/desktop-link/machines/${MAC}/terminals`) return json({ deviceId: MAC, id: "t2", workspaceId: desktopLinkWorkspaceId(MAC), tabId: `tt_${"2".repeat(32)}` }, 201);
    if (key === `DELETE /api/desktop-pairing/${MAC}`) return json({ machineId: MACHINE, deviceId: null, revision: 3 });
    return json({ error: "not_found" }, 404);
  });
  return { request, calls };
}

async function mounted(request: DesktopLinkRequest, onOpen = vi.fn()) {
  const { result } = renderHook(() => useDesktopMachines({ request, intervalMs: 60_000 }));
  await waitFor(() => expect(result.current.desktops.machines).toHaveLength(1));
  await waitFor(() => expect(result.current.terminals[MAC]?.sessions).toHaveLength(1));
  const view = render(<DesktopMachinesGroup state={result.current} now={Date.parse("2026-11-24T10:00:00.000Z")} onOpen={onOpen} />);
  return { result, view, onOpen };
}

describe("desktops group", () => {
  it("is hidden when no desktop is linked, or when the gateway cannot say", async () => {
    const { request } = gateway({ "GET /api/desktop-link/machines": () => json({ error: "unavailable" }, 503) });
    const { result } = renderHook(() => useDesktopMachines({ request, intervalMs: 60_000 }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    const { container } = render(<DesktopMachinesGroup state={result.current} onOpen={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows when an offline desktop was last seen, and never asks for its terminals", async () => {
    const { request, calls } = gateway({ "GET /api/desktop-link/machines": () => json(offline) });
    const { result } = renderHook(() => useDesktopMachines({ request, intervalMs: 60_000 }));
    await waitFor(() => expect(result.current.desktops.machines).toHaveLength(1));
    render(<DesktopMachinesGroup state={result.current} now={Date.parse("2026-11-24T10:00:00.000Z")} onOpen={vi.fn()} />);
    expect(screen.getByText("Offline · Last seen 14 min ago")).toBeTruthy();
    expect(calls.some((call) => call.path.includes("/terminals"))).toBe(false);
  });

  it("lists an online desktop's terminals and opens one by its desktop ref", async () => {
    const { request } = gateway();
    const { onOpen } = await mounted(request);
    expect(screen.getByText("Online")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open claude on Hamed's MacBook Pro" }));
    expect(onOpen).toHaveBeenCalledWith(MAC, expect.objectContaining({ id: "t1", tabId: tab }));
    expect(desktopTerminalRefKey(MAC, { tabId: tab })).toBe(`${desktopLinkWorkspaceId(MAC)}:${tab}`);
  });

  // Fault detected (ENG-574 live check): on the dark Web Terminal drawer the group's
  // buttons kept the page theme's dark foreground and were nearly invisible.
  it("draws its buttons in the surface's own foreground", async () => {
    const { request } = gateway();
    await mounted(request);
    const group = screen.getByRole("region", { name: "Desktops" });
    expect(group.style.getPropertyValue("--matrix-fg")).toBe("currentColor");
  });

  it("opens a terminal it starts at once, and leaves this device out of its own list", async () => {
    const { request } = gateway();
    const { onOpen, view, result } = await mounted(request);
    fireEvent.click(screen.getByRole("button", { name: "Start Codex on Hamed's MacBook Pro" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(MAC, expect.objectContaining({ id: "t2", tabId: `tt_${"2".repeat(32)}`, title: "Codex" })));
    view.rerender(<DesktopMachinesGroup state={result.current} hideDeviceIds={[MAC]} onOpen={onOpen} />);
    expect(screen.queryByText("Hamed's MacBook Pro")).toBeNull();
  });

  // Fault detected (review): a start that waited for the owner's approval opened over the
  // terminal the user had moved to meanwhile.
  it("only lists a started terminal when the user chose another one while it waited", async () => {
    let approve: () => void = () => {};
    const { request } = gateway({
      [`POST /api/desktop-link/machines/${MAC}/terminals`]: () => json({ deviceId: MAC, id: "t2", workspaceId: desktopLinkWorkspaceId(MAC), tabId: `tt_${"2".repeat(32)}` }, 201),
    });
    const slow: DesktopLinkRequest = (path, init) => (init.method === "POST"
      ? new Promise<Response>((resolve) => { approve = () => resolve(request(path, init) as unknown as Response); }).then((response) => response)
      : request(path, init));
    const { onOpen, view, result } = await mounted(slow);
    fireEvent.click(screen.getByRole("button", { name: "Start Codex on Hamed's MacBook Pro" }));
    view.rerender(<DesktopMachinesGroup state={result.current} selectedRefKey="other:tab" onOpen={onOpen} />);
    approve();
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/api/desktop-link/machines/${MAC}/terminals`, expect.objectContaining({ method: "POST" })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("starts a shell or an agent preset on the desktop", async () => {
    const { request, calls } = gateway();
    const { result } = await mounted(request);
    await result.current.start(MAC, "codex");
    await result.current.start(MAC);
    const posts = calls.filter((call) => call.init.method === "POST").map((call) => JSON.parse(call.init.body!));
    expect(posts).toEqual([{ agent: "codex" }, {}]);
  });

  it("removes a desktop only after confirming, by disconnecting its pairing at this revision", async () => {
    const { request, calls } = gateway();
    const { result } = await mounted(request);
    fireEvent.click(screen.getByRole("button", { name: "Remove Hamed's MacBook Pro" }));
    expect(screen.getByText(/This computer loses access at once/)).toBeTruthy();
    expect(calls.some((call) => call.init.method === "DELETE")).toBe(false);
    await result.current.remove(machines.machines[0] as never);
    const removal = calls.find((call) => call.init.method === "DELETE")!;
    expect(removal.path).toBe(`/api/desktop-pairing/${MAC}`);
    expect(removal.init.headers).toEqual({
      "content-type": "application/json",
      "If-Match": desktopPairingRevisionTag({ machineId: MACHINE, deviceId: MAC, revision: 2 }),
    });
    expect(JSON.parse(removal.init.body!)).toEqual({ revision: 2 });
  });

  it("says a refused or offline action plainly, without the gateway's words", async () => {
    const { request } = gateway({ [`POST /api/desktop-link/machines/${MAC}/terminals`]: () => json({ error: "denied", detail: "/etc is outside home" }, 403) });
    const { result } = await mounted(request);
    expect(await result.current.start(MAC)).toBeNull();
    await waitFor(() => expect(result.current.error).toBe("That desktop refused it."));
  });
});
