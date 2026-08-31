// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeOsViewPersistence } from "@desktop/renderer/src/features/desktop-shell/use-native-os-view-persistence";
import { resetNativeOsViewStateClientForTests } from "@desktop/renderer/src/lib/os-view-state-client";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

const loadedState = {
  revision: 1,
  document: createDefaultOsViewDocument(),
  updatedAt: "2026-08-30T12:00:00.000Z",
};

describe("Electron OS-view persistence hook", () => {
  beforeEach(() => {
    resetNativeOsViewStateClientForTests();
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  });

  afterEach(() => vi.restoreAllMocks());

  it("retries a fresh native snapshot after a persistence failure", async () => {
    const api = {
      get: vi.fn(async () => loadedState),
      patch: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ ...loadedState, revision: 2 }),
    };
    const tab = { id: "chat", kind: "work" as const, title: "Chat", closable: false };
    const surfaces = {
      chat: {
        tabId: "chat",
        mode: "window" as const,
        restoreMode: "window" as const,
        bounds: { x: 40, y: 60, width: 900, height: 640 },
        zIndex: 10,
      },
    };
    const tabs = [tab];
    const installedApps: [] = [];
    const viewport = { width: 1200, height: 800 };
    const defaultIconLayout: [] = [];
    useTabs.setState({ tabs, activeTabId: tab.id });
    useDesktopSurfaces.setState({ surfaces });
    const { result } = renderHook(() => useNativeOsViewPersistence({
      api: api as never,
      tabs,
      surfaces,
      installedApps,
      mode: "desktop",
      viewport,
      defaultIconLayout,
    }));
    await waitFor(() => expect(result.current.durableState).toEqual(loadedState));

    act(() => result.current.schedulePersist());
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    expect(api.patch.mock.calls[1][1].patch.desktop.windows).toEqual([
      { path: "__chat__", x: 40, y: 60, width: 900, height: 640 },
    ]);
  });
});
