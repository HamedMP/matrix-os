import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutOverrides } from "@matrix-os/contracts/keyboard-shortcuts";
import { createShortcutService, RECORDING_GUARD_MS } from "@desktop/main/shortcuts/shortcut-service";

function fakeStore(initial: unknown = null) {
  const saved: ShortcutOverrides[] = [];
  return {
    saved,
    get: vi.fn(async () => initial as ShortcutOverrides | null),
    set: vi.fn(async (_key: string, value: ShortcutOverrides) => {
      saved.push(value);
    }),
  };
}

function makeService(store = fakeStore()) {
  // The fake satisfies the two methods the service uses.
  return createShortcutService({ store: store as never, platform: "darwin" });
}

function fakeTarget() {
  return { setIgnoreMenuShortcuts: vi.fn(), isDestroyed: vi.fn(() => false) };
}

describe("shortcut service", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads defaults when nothing is stored", async () => {
    const service = makeService(fakeStore(null));
    await service.load();
    const snapshot = service.snapshot();
    expect(snapshot.platform).toBe("mac");
    expect(snapshot.overrides).toEqual({ version: 1, overrides: {} });
    expect(snapshot.effective["app.next"]).toEqual(["Ctrl+Tab"]);
  });

  it("falls back to defaults without writing when the store cannot be read", async () => {
    const store = fakeStore();
    store.get.mockRejectedValue(new Error("EACCES /home/user/state.json"));
    const service = makeService(store);
    await expect(service.load()).resolves.toBeUndefined();
    expect(service.snapshot().effective["app.close"]).toEqual(["Cmd+Q"]);
    expect(store.set).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("falls back to defaults when the stored value is not an overrides document", async () => {
    const store = fakeStore({ version: 2, overrides: { "app.close": ["F6"] } });
    const service = makeService(store);
    await service.load();
    expect(service.snapshot().overrides).toEqual({ version: 1, overrides: {} });
    expect(service.snapshot().effective["app.close"]).toEqual(["Cmd+Q"]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("keeps the valid parts of stale stored overrides without writing them back", async () => {
    const store = fakeStore({
      version: 1,
      overrides: {
        "app.close": ["F6"],
        "app.minimize": ["Cmd+C"],
        "nav.settings": ["F7"],
        "app.next": ["F7"],
        "app.reopen": [],
        "app.nope": ["F9"],
      },
    });
    const service = makeService(store);
    await service.load();
    const snapshot = service.snapshot();

    expect(snapshot.overrides).toEqual({
      version: 1,
      overrides: { "app.close": ["F6"], "app.next": ["F7"], "app.reopen": [] },
    });
    expect(snapshot.effective["app.close"]).toEqual(["F6"]);
    expect(snapshot.effective["app.minimize"]).toEqual(["Cmd+M"]);
    expect(snapshot.effective["app.next"]).toEqual(["F7"]);
    expect(snapshot.effective["nav.settings"]).toEqual(["Cmd+,"]);
    expect(snapshot.effective["app.reopen"]).toEqual([]);
    expect(store.set).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("drops repeated bindings and keeps at most four per action when sanitizing", async () => {
    const service = makeService(fakeStore({
      version: 1,
      overrides: { "app.launcher": ["F1", "F1", "F2", "F3", "F4", "F5"], "app.close": ["Cmd+C"] },
    }));
    await service.load();
    expect(service.snapshot().overrides).toEqual({
      version: 1,
      overrides: { "app.launcher": ["F1", "F2", "F3", "F4"] },
    });
  });

  it("loads valid stored overrides", async () => {
    const service = makeService(fakeStore({ version: 1, overrides: { "app.close": ["F6"] } }));
    await service.load();
    expect(service.snapshot().effective["app.close"]).toEqual(["F6"]);
  });

  it("persists valid overrides, then updates the snapshot and notifies once", async () => {
    const store = fakeStore();
    const service = makeService(store);
    await service.load();
    const listener = vi.fn();
    service.onChange(listener);
    const overrides = { version: 1 as const, overrides: { "app.close": ["Cmd+Shift+W"] } };

    const snapshot = await service.set(overrides);

    expect(store.saved).toEqual([overrides]);
    expect(store.set).toHaveBeenCalledWith("keyboardShortcuts", overrides);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].effective["app.close"]).toEqual(["Cmd+Shift+W"]);
    expect(snapshot.effective["app.close"]).toEqual(["Cmd+Shift+W"]);
    expect(service.snapshot().effective["app.close"]).toEqual(["Cmd+Shift+W"]);
  });

  it("stops notifying a listener after it unsubscribes", async () => {
    const service = makeService();
    await service.load();
    const listener = vi.fn();
    const unsubscribe = service.onChange(listener);
    unsubscribe();
    await service.set({ version: 1, overrides: { "app.close": ["F6"] } });
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown action id", { "app.nope": ["F6"] }],
    ["a reserved binding", { "app.close": ["Cmd+C"] }],
    ["more bindings than the limit", { "app.close": ["F1", "F2", "F3", "F4", "F5"] }],
    ["a binding shared by two actions", { "app.close": ["F6"], "app.minimize": ["F6"] }],
  ])("rejects %s without touching the store or listeners", async (_name, overrides) => {
    const store = fakeStore();
    const service = makeService(store);
    await service.load();
    const listener = vi.fn();
    service.onChange(listener);
    const before = service.snapshot();

    await expect(service.set({ version: 1, overrides })).rejects.toThrow(/^invalid request$/);

    expect(store.set).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(service.snapshot()).toEqual(before);
  });

  it("keeps the current bindings when persisting fails", async () => {
    const store = fakeStore();
    store.set.mockRejectedValue(new Error("ENOSPC /home/user/state.json"));
    const service = makeService(store);
    await service.load();
    const listener = vi.fn();
    service.onChange(listener);
    const before = service.snapshot();

    await expect(service.set({ version: 1, overrides: { "app.close": ["F6"] } }))
      .rejects.toThrow(/^invalid request$/);

    expect(service.snapshot()).toEqual(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("serializes concurrent sets in call order", async () => {
    const store = fakeStore();
    const releases: Array<() => void> = [];
    store.set.mockImplementation((_key: string, value: ShortcutOverrides) => new Promise<void>((resolve) => {
      releases.push(() => { store.saved.push(value); resolve(); });
    }));
    const service = makeService(store);
    await service.load();
    const first = { version: 1 as const, overrides: { "app.close": ["F6"] } };
    const second = { version: 1 as const, overrides: { "app.close": ["F7"] } };

    const a = service.set(first);
    const b = service.set(second);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]?.();
    await Promise.all([a, b]);

    expect(store.saved).toEqual([first, second]);
    expect(service.snapshot().effective["app.close"]).toEqual(["F7"]);
  });

  it("continues the queue after a failed set", async () => {
    const store = fakeStore();
    store.set.mockRejectedValueOnce(new Error("disk full"));
    const service = makeService(store);
    await service.load();
    const failed = service.set({ version: 1, overrides: { "app.close": ["F6"] } });
    const next = service.set({ version: 1, overrides: { "app.close": ["F7"] } });
    await expect(failed).rejects.toThrow("invalid request");
    await expect(next).resolves.toMatchObject({ effective: { "app.close": ["F7"] } });
  });

  it("ignores menu shortcuts while recording and stops after the guard time", () => {
    vi.useFakeTimers();
    const service = makeService();
    const target = fakeTarget();

    service.setRecording(target, true);
    expect(target.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true);
    expect(RECORDING_GUARD_MS).toBe(30_000);

    vi.advanceTimersByTime(RECORDING_GUARD_MS);
    expect(target.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(target.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(2);
  });

  it("clears the guard timer when recording stops", () => {
    vi.useFakeTimers();
    const service = makeService();
    const target = fakeTarget();

    service.setRecording(target, true);
    service.setRecording(target, false);
    expect(target.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(RECORDING_GUARD_MS * 2);
    expect(target.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(2);
  });

  it("restarts one guard timer when recording starts again", () => {
    vi.useFakeTimers();
    const service = makeService();
    const target = fakeTarget();

    service.setRecording(target, true);
    vi.advanceTimersByTime(RECORDING_GUARD_MS - 1);
    service.setRecording(target, true);
    vi.advanceTimersByTime(RECORDING_GUARD_MS - 1);
    expect(target.setIgnoreMenuShortcuts).not.toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(1);
    expect(target.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
  });

  it("releases the previous window when another window starts recording", () => {
    vi.useFakeTimers();
    const service = makeService();
    const first = fakeTarget();
    const second = fakeTarget();

    service.setRecording(first, true);
    service.setRecording(second, true);

    expect(first.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(second.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
  });

  it("keeps the guard when a window that is not recording stops", () => {
    vi.useFakeTimers();
    const service = makeService();
    const recorder = fakeTarget();
    const other = fakeTarget();

    service.setRecording(recorder, true);
    service.setRecording(other, false);
    vi.advanceTimersByTime(RECORDING_GUARD_MS);

    expect(recorder.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
  });

  it("skips destroyed targets", () => {
    vi.useFakeTimers();
    const service = makeService();
    const target = fakeTarget();
    target.isDestroyed.mockReturnValue(true);

    service.setRecording(target, true);
    service.setRecording(target, false);
    vi.advanceTimersByTime(RECORDING_GUARD_MS);

    expect(target.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });

  it("reports recording from start until the matching stop or the guard time", () => {
    vi.useFakeTimers();
    const service = makeService();
    const recorder = fakeTarget();
    const other = fakeTarget();
    expect(service.isRecording()).toBe(false);

    service.setRecording(recorder, true);
    expect(service.isRecording()).toBe(true);
    service.setRecording(other, false);
    expect(service.isRecording()).toBe(true);
    service.setRecording(recorder, false);
    expect(service.isRecording()).toBe(false);

    service.setRecording(recorder, true);
    vi.advanceTimersByTime(RECORDING_GUARD_MS);
    expect(service.isRecording()).toBe(false);
  });

  it("clears the guard timer on dispose", () => {
    vi.useFakeTimers();
    const service = makeService();
    const target = fakeTarget();

    service.setRecording(target, true);
    service.dispose();
    vi.advanceTimersByTime(RECORDING_GUARD_MS);

    expect(target.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(1);
  });
});
