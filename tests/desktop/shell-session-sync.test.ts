// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import {
  SHELL_SESSION_SYNC_INTERVAL_MS,
  startShellSessionSync,
  syncShellSessions,
} from "@desktop/renderer/src/lib/shell-session-sync";
import { useShellSessions } from "@desktop/renderer/src/stores/shell-sessions";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("desktop shell-session synchronization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useShellSessions.setState(useShellSessions.getInitialState(), true);
    useTabs.setState(useTabs.getInitialState(), true);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reconciles tabs only from an accepted authoritative snapshot", async () => {
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    useTabs.getState().openTab({ kind: "terminal", sessionName: "matrix-deleted", title: "matrix-deleted" });
    const load = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([]);
    useShellSessions.setState({ load });

    expect(await syncShellSessions({} as ApiClient)).toBeNull();
    expect(useTabs.getState().tabs).toHaveLength(2);

    expect(await syncShellSessions({} as ApiClient)).toEqual([]);
    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([home]);
  });

  it("polls every five seconds while visible and applies external deletion", async () => {
    const api = {} as ApiClient;
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    useTabs.getState().openTab({ kind: "terminal", sessionName: "matrix-main", title: "matrix-main" });
    const load = vi.fn()
      .mockResolvedValueOnce([{ name: "matrix-main", status: "active" }])
      .mockResolvedValueOnce([]);
    useShellSessions.setState({ load });

    const stop = startShellSessionSync(api);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(SHELL_SESSION_SYNC_INTERVAL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([home]);
    stop();
  });

  it("refreshes on focus and visibility restoration, but pauses hidden polling", async () => {
    const load = vi.fn().mockResolvedValue([]);
    useShellSessions.setState({ load });
    const stop = startShellSessionSync({} as ApiClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await vi.advanceTimersByTimeAsync(SHELL_SESSION_SYNC_INTERVAL_MS * 2);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does not overlap slow refreshes and stops timers and listeners on cleanup", async () => {
    const pending = deferred<[]>();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    useShellSessions.setState({ load });
    const stop = startShellSessionSync({} as ApiClient);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(SHELL_SESSION_SYNC_INTERVAL_MS * 2);
    window.dispatchEvent(new Event("focus"));
    expect(load).toHaveBeenCalledTimes(1);

    pending.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SHELL_SESSION_SYNC_INTERVAL_MS);
    expect(load).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(SHELL_SESSION_SYNC_INTERVAL_MS * 2);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
