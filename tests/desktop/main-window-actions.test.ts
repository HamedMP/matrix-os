import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_WINDOW_ACTIONS_READY_TIMEOUT_MS,
  createMainWindowActionGate,
} from "@desktop/main/installed-apps/main-window-actions";

describe("main window action gate", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function setup(options: { open?: boolean; signedIn?: boolean; reopen?: () => Promise<void> } = {}) {
    let open = options.open ?? false;
    const created: number[] = [];
    const reopen = vi.fn(options.reopen ?? (async () => { created.push(created.length); open = true; }));
    const showMainWindow = vi.fn();
    const gate = createMainWindowActionGate({
      hasMainWindow: () => open,
      isSignedIn: () => options.signedIn ?? true,
      reopenMainWindow: reopen,
      showMainWindow,
    });
    return { gate, reopen, showMainWindow, created, close: () => { open = false; gate.rendererReset(); } };
  }

  it("delivers at once while the main window is open, as before", async () => {
    const { gate, reopen } = setup({ open: true });
    await expect(gate.ensure("App launch is unavailable")).resolves.toBeUndefined();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("reopens a closed main window and waits until its renderer can take actions", async () => {
    const { gate, reopen } = setup();
    let delivered = false;
    const pending = gate.ensure("App launch is unavailable").then(() => { delivered = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(reopen).toHaveBeenCalledOnce();
    expect(delivered).toBe(false);
    gate.rendererReady();
    await pending;
    expect(delivered).toBe(true);
  });

  it("shares one reopen between concurrent actions", async () => {
    const { gate, reopen, created } = setup();
    const actions = [gate.ensure("a"), gate.ensure("b"), gate.ensure("c")];
    await vi.advanceTimersByTimeAsync(0);
    gate.rendererReady();
    await Promise.all(actions);
    expect(reopen).toHaveBeenCalledOnce();
    expect(created).toHaveLength(1);
  });

  it("holds an action that arrives after the reopened window exists but before its renderer is ready", async () => {
    const { gate, reopen } = setup();
    const first = gate.ensure("a");
    await vi.advanceTimersByTimeAsync(0);
    let lateDelivered = false;
    const late = gate.ensure("b").then(() => { lateDelivered = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateDelivered).toBe(false);
    gate.rendererReady();
    await Promise.all([first, late]);
    expect(lateDelivered).toBe(true);
    expect(reopen).toHaveBeenCalledOnce();
  });

  it("fails with the generic message when the renderer is not ready in time", async () => {
    const { gate } = setup();
    const pending = gate.ensure("App task is unavailable");
    const expectation = expect(pending).rejects.toThrow("App task is unavailable");
    await vi.advanceTimersByTimeAsync(MAIN_WINDOW_ACTIONS_READY_TIMEOUT_MS);
    await expectation;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails generically when the window cannot be reopened", async () => {
    const failing = setup({ reopen: async () => { throw new Error("raw renderer path /Users/x"); } });
    await expect(failing.gate.ensure("App launch is unavailable")).rejects.toThrow(/^App launch is unavailable$/);
  });

  it.each([false, true])("fails at once while signed out and brings Matrix forward to sign in (main open: %s)", async (open) => {
    const { gate, reopen, showMainWindow } = setup({ signedIn: false, open });
    await expect(gate.ensure("App launch is unavailable")).rejects.toThrow(/^App launch is unavailable$/);
    expect(showMainWindow).toHaveBeenCalledOnce();
    expect(reopen).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits again after the main renderer resets", async () => {
    const { gate, reopen, close } = setup();
    const first = gate.ensure("a");
    await vi.advanceTimersByTimeAsync(0);
    gate.rendererReady();
    await first;
    close();
    const second = gate.ensure("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(reopen).toHaveBeenCalledTimes(2);
    gate.rendererReady();
    await expect(second).resolves.toBeUndefined();
  });

  it("bounds waiting actions by failing the oldest first", async () => {
    const { gate } = setup();
    const waiters = Array.from({ length: 10 }, (_, index) => gate.ensure(`action ${index}`).then(() => "ok", () => "failed"));
    await vi.advanceTimersByTimeAsync(0);
    gate.rendererReady();
    expect(await Promise.all(waiters)).toEqual(["failed", "failed", ...Array.from({ length: 8 }, () => "ok")]);
  });

  it("fails waiting actions and clears their timers on quit", async () => {
    const { gate } = setup();
    const pending = gate.ensure("App task is unavailable");
    const expectation = expect(pending).rejects.toThrow("App task is unavailable");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    gate.dispose();
    await expectation;
    expect(vi.getTimerCount()).toBe(0);
  });
});
