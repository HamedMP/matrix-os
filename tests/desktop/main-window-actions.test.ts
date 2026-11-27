import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_WINDOW_ACTIONS_READY_TIMEOUT_MS,
  createMainWindowActionGate,
} from "@desktop/main/installed-apps/main-window-actions";

const AUTHORITY = { runtimeSlot: "primary", authGeneration: 4 };
type Gate = ReturnType<typeof createMainWindowActionGate>;
const ensure = (gate: Gate, message: string, isCurrent: () => boolean = () => true) => gate.ensure(message, isCurrent);

describe("main window action gate", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function setup(options: { open?: boolean; signedIn?: boolean; reopen?: () => Promise<void> } = {}) {
    let open = options.open ?? false;
    let authority: typeof AUTHORITY | null = options.signedIn === false ? null : { ...AUTHORITY };
    const created: number[] = [];
    const reopen = vi.fn(options.reopen ?? (async () => { created.push(created.length); open = true; }));
    const showMainWindow = vi.fn();
    const gate = createMainWindowActionGate({
      hasMainWindow: () => open,
      authority: () => authority,
      reopenMainWindow: reopen,
      showMainWindow,
    });
    return { gate, reopen, showMainWindow, created, close: () => { open = false; gate.rendererReset(); },
      setAuthority: (next: typeof AUTHORITY | null) => { authority = next; } };
  }

  it("delivers at once while the main window is open, as before", async () => {
    const { gate, reopen } = setup({ open: true });
    await expect(ensure(gate, "App launch is unavailable")).resolves.toEqual(AUTHORITY);
    expect(reopen).not.toHaveBeenCalled();
  });

  describe("keeps an action bound to the session and app that asked for it", () => {
    // What index.ts does: deliver with the authority the gate returns, or send nothing.
    async function deliver(gate: Gate, isCurrent: () => boolean, sent: unknown[]) {
      const authority = await gate.ensure("App task is unavailable", isCurrent);
      sent.push({ context: "Read my notes", ...authority });
    }

    it("delivers once, with the authority captured before the wait, when nothing changed", async () => {
      const { gate } = setup();
      const sent: unknown[] = [];
      const pending = deliver(gate, () => true, sent);
      await vi.advanceTimersByTimeAsync(0);
      gate.rendererReady();
      await pending;
      expect(sent).toEqual([{ context: "Read my notes", ...AUTHORITY }]);
    });

    it.each([
      ["another Matrix computer is selected", { runtimeSlot: "work", authGeneration: 5 }, true],
      ["the owner signs out and back in", { runtimeSlot: "primary", authGeneration: 5 }, true],
      ["the owner signs out", null, true],
      ["the requesting app's document is gone", AUTHORITY, false],
    ] as const)("sends nothing when %s during the wait", async (_label, nextAuthority, senderStaysCurrent) => {
      const { gate, setAuthority } = setup();
      let current = true;
      const sent: unknown[] = [];
      const pending = deliver(gate, () => current, sent);
      const expectation = expect(pending).rejects.toThrow(/^App task is unavailable$/);
      await vi.advanceTimersByTimeAsync(0);
      setAuthority(nextAuthority ? { ...nextAuthority } : null);
      current = senderStaysCurrent;
      gate.rendererReady();
      await expectation;
      expect(sent).toEqual([]);
    });

    it("refuses an app whose document is already gone, even with the main window open", async () => {
      const { gate, reopen } = setup({ open: true });
      await expect(ensure(gate, "App launch is unavailable", () => false)).rejects.toThrow(/^App launch is unavailable$/);
      expect(reopen).not.toHaveBeenCalled();
    });
  });

  it("reopens a closed main window and waits until its renderer can take actions", async () => {
    const { gate, reopen } = setup();
    let delivered = false;
    const pending = ensure(gate, "App launch is unavailable").then(() => { delivered = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(reopen).toHaveBeenCalledOnce();
    expect(delivered).toBe(false);
    gate.rendererReady();
    await pending;
    expect(delivered).toBe(true);
  });

  it("shares one reopen between concurrent actions", async () => {
    const { gate, reopen, created } = setup();
    const actions = [ensure(gate, "a"), ensure(gate, "b"), ensure(gate, "c")];
    await vi.advanceTimersByTimeAsync(0);
    gate.rendererReady();
    await Promise.all(actions);
    expect(reopen).toHaveBeenCalledOnce();
    expect(created).toHaveLength(1);
  });

  it("holds an action that arrives after the reopened window exists but before its renderer is ready", async () => {
    const { gate, reopen } = setup();
    const first = ensure(gate, "a");
    await vi.advanceTimersByTimeAsync(0);
    let lateDelivered = false;
    const late = ensure(gate, "b").then(() => { lateDelivered = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateDelivered).toBe(false);
    gate.rendererReady();
    await Promise.all([first, late]);
    expect(lateDelivered).toBe(true);
    expect(reopen).toHaveBeenCalledOnce();
  });

  it("fails with the generic message when the renderer is not ready in time", async () => {
    const { gate } = setup();
    const pending = ensure(gate, "App task is unavailable");
    const expectation = expect(pending).rejects.toThrow("App task is unavailable");
    await vi.advanceTimersByTimeAsync(MAIN_WINDOW_ACTIONS_READY_TIMEOUT_MS);
    await expectation;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails generically when the window cannot be reopened", async () => {
    const failing = setup({ reopen: async () => { throw new Error("raw renderer path /Users/x"); } });
    await expect(ensure(failing.gate, "App launch is unavailable")).rejects.toThrow(/^App launch is unavailable$/);
  });

  it.each([false, true])("fails at once while signed out and brings Matrix forward to sign in (main open: %s)", async (open) => {
    const { gate, reopen, showMainWindow } = setup({ signedIn: false, open });
    await expect(ensure(gate, "App launch is unavailable")).rejects.toThrow(/^App launch is unavailable$/);
    expect(showMainWindow).toHaveBeenCalledOnce();
    expect(reopen).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits again after the main renderer resets", async () => {
    const { gate, reopen, close } = setup();
    const first = ensure(gate, "a");
    await vi.advanceTimersByTimeAsync(0);
    gate.rendererReady();
    await first;
    close();
    const second = ensure(gate, "b");
    await vi.advanceTimersByTimeAsync(0);
    expect(reopen).toHaveBeenCalledTimes(2);
    gate.rendererReady();
    await expect(second).resolves.toEqual(AUTHORITY);
  });

  it("bounds waiting actions by failing the oldest first", async () => {
    const { gate } = setup();
    const waiters = Array.from({ length: 10 }, (_, index) => ensure(gate, `action ${index}`).then(() => "ok", () => "failed"));
    await vi.advanceTimersByTimeAsync(0);
    gate.rendererReady();
    expect(await Promise.all(waiters)).toEqual(["failed", "failed", ...Array.from({ length: 8 }, () => "ok")]);
  });

  it("fails waiting actions and clears their timers on quit", async () => {
    const { gate } = setup();
    const pending = ensure(gate, "App task is unavailable");
    const expectation = expect(pending).rejects.toThrow("App task is unavailable");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    gate.dispose();
    await expectation;
    expect(vi.getTimerCount()).toBe(0);
  });
});
