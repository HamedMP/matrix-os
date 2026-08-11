// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDirectorySync,
  type DirectorySyncSocket,
} from "@desktop/renderer/src/features/files/use-directory-sync";
import type { FileDirectoryServerMessage } from "@desktop/renderer/src/lib/kernel-socket";

class FakeDirectorySocket implements DirectorySyncSocket {
  readonly subscriptions: Array<{ directory: string; handler: (message: FileDirectoryServerMessage) => void; active: boolean }> = [];
  readonly subscribeDirectory = vi.fn((directory: string, handler: (message: FileDirectoryServerMessage) => void) => {
    const record = { directory, handler, active: true };
    this.subscriptions.push(record);
    return () => { record.active = false; };
  });
  readonly touchDirectory = vi.fn(() => true);

  emit(message: FileDirectoryServerMessage): void {
    for (const subscription of this.subscriptions) {
      if (subscription.active && (message.type === "files:shutdown" || message.directory === subscription.directory)) {
        subscription.handler(message);
      }
    }
  }
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("useDirectorySync", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("subscribes the current scope, exposes best-effort touch, and unsubscribes on cleanup", () => {
    const socket = new FakeDirectorySocket();
    const { result, unmount } = renderHook(() => useDirectorySync({
      socket, directory: "projects", runtimeSlot: "primary", authGeneration: 1,
      loadDirectory: async () => [], onReconciled: () => {},
    }));

    expect(socket.subscribeDirectory).toHaveBeenCalledWith("projects", expect.any(Function));
    expect(result.current.touch()).toBe(true);
    expect(socket.touchDirectory).toHaveBeenCalledWith("projects");
    unmount();
    expect(socket.subscriptions[0]?.active).toBe(false);
    expect(result.current.touch()).toBe(false);
  });

  it("establishes each subscribed baseline with an authoritative reload", async () => {
    const socket = new FakeDirectorySocket();
    const loadDirectory = vi.fn().mockResolvedValue(["projects/a"]);
    const onReconciled = vi.fn();
    renderHook(() => useDirectorySync({
      socket, directory: "projects", runtimeSlot: "primary", authGeneration: 1,
      loadDirectory, onReconciled,
    }));

    act(() => socket.emit({ type: "files:subscribed", directory: "projects", revision: 4 }));
    await flush();
    act(() => socket.emit({ type: "files:subscribed", directory: "projects", revision: 0 }));
    await flush();

    expect(loadDirectory).toHaveBeenCalledTimes(2);
    expect(onReconciled).toHaveBeenNthCalledWith(1, ["projects/a"]);
    expect(onReconciled).toHaveBeenNthCalledWith(2, ["projects/a"]);
  });

  it("debounces an exact revision burst for exactly 150 ms", async () => {
    const socket = new FakeDirectorySocket();
    const loadDirectory = vi.fn().mockResolvedValue([]);
    renderHook(() => useDirectorySync({
      socket, directory: "projects", runtimeSlot: "primary", authGeneration: 1,
      loadDirectory, onReconciled: () => {},
    }));
    act(() => socket.emit({ type: "files:subscribed", directory: "projects", revision: 0 }));
    await flush();
    loadDirectory.mockClear();

    act(() => {
      socket.emit({ type: "files:change", directory: "projects", entry: "a", event: "add", revision: 1 });
      vi.advanceTimersByTime(75);
      socket.emit({ type: "files:change", directory: "projects", entry: "b", event: "change", revision: 2 });
      socket.emit({ type: "files:change", directory: "projects", entry: "c", event: "unlink", revision: 3 });
      vi.advanceTimersByTime(149);
    });
    expect(loadDirectory).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    await flush();
    expect(loadDirectory).toHaveBeenCalledOnce();
  });

  it("reloads immediately on a revision gap, decrease/reset, missing baseline, or shutdown", async () => {
    const socket = new FakeDirectorySocket();
    const loadDirectory = vi.fn().mockResolvedValue([]);
    renderHook(() => useDirectorySync({
      socket, directory: "projects", runtimeSlot: "primary", authGeneration: 1,
      loadDirectory, onReconciled: () => {},
    }));

    act(() => socket.emit({ type: "files:change", directory: "projects", entry: "a", event: "add", revision: 5 }));
    await flush();
    act(() => socket.emit({ type: "files:change", directory: "projects", entry: "b", event: "add", revision: 7 }));
    await flush();
    act(() => socket.emit({ type: "files:change", directory: "projects", entry: "c", event: "change", revision: 2 }));
    await flush();
    act(() => socket.emit({ type: "files:shutdown" }));
    await flush();

    expect(loadDirectory).toHaveBeenCalledTimes(4);
  });

  it("cancels a stale debounce on directory/runtime/auth changes", async () => {
    const socket = new FakeDirectorySocket();
    const loadDirectory = vi.fn().mockResolvedValue([]);
    const props = { directory: "projects", runtimeSlot: "primary", authGeneration: 1 };
    const { rerender } = renderHook(
      (current: typeof props) => useDirectorySync({ socket, ...current, loadDirectory, onReconciled: () => {} }),
      { initialProps: props },
    );
    act(() => socket.emit({ type: "files:subscribed", directory: "projects", revision: 0 }));
    await flush();
    loadDirectory.mockClear();
    act(() => socket.emit({ type: "files:change", directory: "projects", entry: "a", event: "add", revision: 1 }));

    rerender({ directory: "archive", runtimeSlot: "preview", authGeneration: 2 });
    act(() => vi.advanceTimersByTime(150));
    await flush();

    expect(loadDirectory).not.toHaveBeenCalled();
    expect(socket.subscriptions.map((subscription) => [subscription.directory, subscription.active])).toEqual([
      ["projects", false], ["archive", true],
    ]);
  });

  it("suppresses a stale reload promise from a previous scope", async () => {
    let resolveOld!: (value: string[]) => void;
    const oldLoad = new Promise<string[]>((resolve) => { resolveOld = resolve; });
    const socket = new FakeDirectorySocket();
    const loadDirectory = vi.fn()
      .mockReturnValueOnce(oldLoad)
      .mockResolvedValueOnce(["archive/new"]);
    const onReconciled = vi.fn();
    const { rerender } = renderHook(
      (props: { directory: string; runtimeSlot: string; authGeneration: number }) =>
        useDirectorySync({ socket, ...props, loadDirectory, onReconciled }),
      { initialProps: { directory: "projects", runtimeSlot: "primary", authGeneration: 1 } },
    );
    act(() => socket.emit({ type: "files:subscribed", directory: "projects", revision: 0 }));
    rerender({ directory: "archive", runtimeSlot: "preview", authGeneration: 2 });
    act(() => socket.emit({ type: "files:subscribed", directory: "archive", revision: 0 }));
    await flush();
    expect(onReconciled).toHaveBeenCalledWith(["archive/new"]);

    resolveOld(["projects/stale"]);
    await flush();
    expect(onReconciled).toHaveBeenCalledTimes(1);
  });
});
