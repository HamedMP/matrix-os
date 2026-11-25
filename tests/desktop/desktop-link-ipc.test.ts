// IPC for the Desktop link (spec 2716): only the Terminal window may call it,
// payloads are validated in main, failures come back as fixed reasons, and
// every status change reaches the window.
import { describe, expect, it, vi } from "vitest";
import { registerDesktopLinkIpc } from "../../desktop/src/main/desktop-link/ipc";
import { DesktopLinkEnableError, type DesktopLinkService, type DesktopLinkStatus } from "../../desktop/src/main/desktop-link/service";
import { TERMINAL_WINDOW_INVOKE_CHANNELS, windowMayInvoke } from "../../desktop/src/shared/terminal-window";

function setup(overrides: Partial<DesktopLinkService> = {}) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const listeners: Array<(status: DesktopLinkStatus) => void> = [];
  const service = {
    statuses: vi.fn(() => [{ slot: "primary", computerName: "matrix-demo", state: "on", terminalsFromComputer: 1 }]),
    deviceIds: vi.fn(() => ["c".repeat(64)]),
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    onStatus: vi.fn((listener: (status: DesktopLinkStatus) => void) => { listeners.push(listener); return () => undefined; }),
    ...overrides,
  } as unknown as DesktopLinkService;
  const emit = vi.fn();
  const authorize = vi.fn((event: unknown) => event === "terminal-window");
  registerDesktopLinkIpc({ handle: (channel, listener) => { handlers.set(channel, listener as never); } }, service, authorize, emit);
  const call = (channel: string, payload: unknown, event: unknown = "terminal-window") => handlers.get(channel)!(event, payload);
  return { service, emit, call, listeners };
}

describe("Desktop link IPC", () => {
  it("changes and reports links only from the Terminal window; both windows may ask which desktop this is", () => {
    for (const channel of ["desktop-link:status", "desktop-link:enable", "desktop-link:disable"] as const) {
      expect(TERMINAL_WINDOW_INVOKE_CHANNELS).toContain(channel);
      expect(windowMayInvoke("main", channel, {})).toBe(false);
    }
    expect(windowMayInvoke("main", "desktop-link:this-device", {})).toBe(true);
    expect(windowMayInvoke("terminal", "desktop-link:this-device", {})).toBe(true);
  });

  it("refuses other senders and malformed payloads before touching the service", async () => {
    const { call, service } = setup();
    await expect(call("desktop-link:enable", { slot: "primary", computerName: "x" }, "main-window")).rejects.toThrow("invalid request");
    await expect(call("desktop-link:enable", { slot: "../etc", computerName: "x" })).rejects.toThrow("invalid request");
    await expect(call("desktop-link:disable", { slot: "primary", extra: 1 })).rejects.toThrow("invalid request");
    expect(service.enable).not.toHaveBeenCalled();
    expect(service.disable).not.toHaveBeenCalled();
  });

  it("enables and disables, mapping failures to fixed reasons", async () => {
    const { call, service } = setup({
      enable: vi.fn(async (slot: string) => { if (slot === "extra") throw new DesktopLinkEnableError("too_many"); if (slot === "boom") throw new TypeError("x"); }),
    } as never);
    await expect(call("desktop-link:enable", { slot: "primary", computerName: "matrix-demo" })).resolves.toEqual({ ok: true });
    await expect(call("desktop-link:enable", { slot: "extra", computerName: "x" })).resolves.toEqual({ ok: false, reason: "too_many" });
    await expect(call("desktop-link:enable", { slot: "boom", computerName: "x" })).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(call("desktop-link:disable", { slot: "primary" })).resolves.toEqual({ ok: true });
    expect(service.disable).toHaveBeenCalledWith("primary");
    await expect(call("desktop-link:this-device", {})).resolves.toEqual({ deviceIds: ["c".repeat(64)] });
    await expect(call("desktop-link:status", {})).resolves.toEqual({ computers: [{ slot: "primary", computerName: "matrix-demo", state: "on", terminalsFromComputer: 1 }] });
  });

  it("forwards status changes to the window", () => {
    const { listeners, emit } = setup();
    listeners[0]!({ slot: "primary", computerName: "matrix-demo", state: "off", terminalsFromComputer: 0 });
    expect(emit).toHaveBeenCalledWith("desktop-link:changed", { slot: "primary", computerName: "matrix-demo", state: "off", terminalsFromComputer: 0 });
  });
});
