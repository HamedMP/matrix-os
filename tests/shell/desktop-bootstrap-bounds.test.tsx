// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import { useDesktopBootstrap } from "../../shell/src/components/desktop/useDesktopBootstrap";
import { resetWindowManagerLayoutPersistenceForTests, useWindowManager } from "../../shell/src/hooks/useWindowManager";
import { resetWebOsViewStateClientForTests } from "../../shell/src/lib/os-view-state-client";

beforeEach(() => {
  useWindowManager.setState(useWindowManager.getInitialState(), true);
  resetWebOsViewStateClientForTests();
});
afterEach(() => {
  cleanup();
  resetWindowManagerLayoutPersistenceForTests();
  vi.unstubAllGlobals();
});

function bootstrapWithWindows(count: number) {
  const windows = Array.from({ length: count }, (_, index) => ({
    path: `apps/restored-${index}/dist/index.html`, title: `Restored ${index}`,
    x: 100, y: 60, width: 700, height: 400, state: "open" as const,
  }));
  return { layout: { windows }, modules: [], apps: windows.map((window) => ({ name: window.title, path: `/files/${window.path}` })) };
}
function serveBootstrap(bootstrap: ReturnType<typeof bootstrapWithWindows>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes("/api/shell/bootstrap")
    ? bootstrap : { revision: 1, document: createDefaultOsViewDocument(), updatedAt: "2026-10-01T00:00:00.000Z" })));
}

describe("Web bootstrap restoration bounds", () => {
  it("restores every valid window at the 512-window contract limit in order", async () => {
    const bootstrap = bootstrapWithWindows(512);
    serveBootstrap(bootstrap);
    const { result } = renderHook(() => useDesktopBootstrap({ entryKey: "limit", openWindow: vi.fn() }));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(useWindowManager.getState().windows.map((window) => window.path)).toEqual(bootstrap.layout.windows.map((window) => window.path));
  });

  it("rejects a malformed oversized legacy restore batch without truncating it or hanging startup", async () => {
    serveBootstrap(bootstrapWithWindows(513));
    const { result } = renderHook(() => useDesktopBootstrap({ entryKey: "oversized", openWindow: vi.fn() }));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(useWindowManager.getState().windows).toEqual([]);
  });

  it("retains last-write-wins lookup for duplicate installed-app layout paths", async () => {
    const bootstrap = bootstrapWithWindows(1);
    bootstrap.layout.windows.push({ ...bootstrap.layout.windows[0]!, x: 330, title: "Last saved window" });
    serveBootstrap(bootstrap);
    const { result } = renderHook(() => useDesktopBootstrap({ entryKey: "duplicates", openWindow: vi.fn() }));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(useWindowManager.getState().windows).toHaveLength(1);
    expect(useWindowManager.getState().windows[0]).toMatchObject({ x: 330, title: "Last saved window" });
  });
});
