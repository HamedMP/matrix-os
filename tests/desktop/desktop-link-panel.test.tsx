// @vitest-environment jsdom
// The Terminal window's desktop link controls (spec 2716): nothing is linked
// before the device is paired in 2698's native dialog, the state main reports,
// an instant Turn off, and Turn on again after Stop.
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopLinkPanel } from "@desktop/renderer/src/features/terminal-window/DesktopLinkPanel";
import { useDesktopLink } from "@desktop/renderer/src/features/terminal-window/use-desktop-link";

const listeners = new Map<string, Array<(payload: unknown) => void>>();
const emit = (channel: string, payload: unknown) => act(() => { for (const listener of listeners.get(channel) ?? []) listener(payload); });
let replies: Record<string, unknown>;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});
beforeEach(() => {
  listeners.clear();
  replies = { "desktop-link:status": { computers: [] }, "desktop-link:enable": { ok: true }, "desktop-link:disable": { ok: true }, "desktop-link:pair": { ok: true } };
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
  return <DesktopLinkPanel link={link} />;
}

describe("Desktop link panel", () => {
  it("links nothing itself: pairing happens in 2698's native dialog, which main opens", async () => {
    render(<Harness />);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByText("Pair this device with your computer…"));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("desktop-link:pair", {}));
    expect(window.operator.invoke).not.toHaveBeenCalledWith("desktop-link:enable", expect.anything());
  });

  it("shows what main reports, turns the link off at once, and back on after Stop", async () => {
    render(<Harness />);
    emit("desktop-link:changed", { slot: "primary", computerName: "matrix-demo", state: "on", terminalsFromComputer: 2 });
    expect(screen.getByRole("status").textContent).toBe("matrix-demo can use this device · 2 terminals open from it");
    expect(screen.queryByText("Pair this device with your computer…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop matrix-demo using this device" }));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("desktop-link:disable", { slot: "primary" }));
    emit("desktop-link:changed", { slot: "primary", computerName: "matrix-demo", state: "off", terminalsFromComputer: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Let matrix-demo use this device" }));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("desktop-link:enable", { slot: "primary", computerName: "matrix-demo" }));
  });

  it("offers pairing again once the computer removed this device, and ignores malformed reports", async () => {
    replies["desktop-link:enable"] = { ok: false, reason: "not_paired" };
    render(<Harness />);
    emit("desktop-link:changed", { slot: "primary", state: "on" });
    expect(screen.queryByRole("status")).toBeNull();
    emit("desktop-link:changed", { slot: "primary", computerName: "matrix-demo", state: "removed", terminalsFromComputer: 0 });
    expect(screen.getByRole("status").textContent).toBe("matrix-demo is no longer paired with this device");
    expect(screen.queryByRole("button", { name: /matrix-demo using this device/ })).toBeNull();
    expect(screen.getByText("Pair this device with your computer…")).toBeTruthy();
    emit("desktop-link:changed", { slot: "primary", computerName: "matrix-demo", state: "off", terminalsFromComputer: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Let matrix-demo use this device" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This device isn't paired with your computer any more. Pair it again.");
  });
});
