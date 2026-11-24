// @vitest-environment jsdom
// The Terminal window's Desktop link controls (spec 2716): off by default, a
// confirmation that names full shell access before anything is linked, the
// state main reports, and an instant Turn off.
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixComputer } from "@matrix-os/contracts";
import { DesktopLinkPanel } from "@desktop/renderer/src/features/terminal-window/DesktopLinkPanel";
import { useDesktopLink } from "@desktop/renderer/src/features/terminal-window/use-desktop-link";

const computers: MatrixComputer[] = [
  { handle: "neo", runtimeSlot: "primary", label: "matrix-demo", availability: "available", kind: "customer", gatewayPath: "/vm/neo", capabilities: [] },
];

const listeners = new Map<string, Array<(payload: unknown) => void>>();
const emit = (channel: string, payload: unknown) => act(() => { for (const listener of listeners.get(channel) ?? []) listener(payload); });
let replies: Record<string, unknown>;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});
beforeEach(() => {
  listeners.clear();
  replies = { "desktop-link:status": { computers: [] }, "desktop-link:enable": { ok: true }, "desktop-link:disable": { ok: true } };
  window.operator = {
    invoke: vi.fn(async (channel: string) => replies[channel]),
    on: (channel, callback) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== callback));
    },
  };
});
afterEach(() => cleanup());

function Harness() {
  const link = useDesktopLink();
  return <DesktopLinkPanel link={link} computers={computers} />;
}

describe("Desktop link panel", () => {
  it("links nothing until the person confirms full shell access for one computer", async () => {
    render(<Harness />);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByText("Let a computer use this device…"));
    fireEvent.click(screen.getByRole("button", { name: "Turn on…" }));
    expect(screen.getByText(/full\s+shell access/)).toBeTruthy();
    expect(window.operator.invoke).not.toHaveBeenCalledWith("desktop-link:enable", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Let matrix-demo use this device" }));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("desktop-link:enable", { slot: "primary", computerName: "matrix-demo" }));
  });

  it("shows what main reports, and turns a computer off at once", async () => {
    render(<Harness />);
    emit("desktop-link:changed", { slot: "primary", computerName: "matrix-demo", state: "on", terminalsFromComputer: 2 });
    expect(screen.getByRole("status").textContent).toBe("matrix-demo can use this device · 2 terminals open from it");
    fireEvent.click(screen.getByRole("button", { name: "Stop matrix-demo using this device" }));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("desktop-link:disable", { slot: "primary" }));
    emit("desktop-link:changed", { slot: "primary", computerName: "matrix-demo", state: "removed", terminalsFromComputer: 0 });
    expect(screen.getByRole("status").textContent).toBe("matrix-demo removed this device");
    expect(screen.queryByRole("button", { name: /Stop matrix-demo/ })).toBeNull();
  });

  it("says why a computer refused, and ignores malformed reports", async () => {
    replies["desktop-link:enable"] = { ok: false, reason: "too_many" };
    render(<Harness />);
    emit("desktop-link:changed", { slot: "primary", state: "on" });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByText("Let a computer use this device…"));
    fireEvent.click(screen.getByRole("button", { name: "Turn on…" }));
    fireEvent.click(screen.getByRole("button", { name: "Let matrix-demo use this device" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That computer already has five desktops. Remove one there first.");
  });
});
