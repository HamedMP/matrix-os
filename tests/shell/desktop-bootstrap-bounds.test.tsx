// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultOsViewDocument, mergeOsViewStatePatch } from "@matrix-os/contracts";
import { useCatalogAppShortcuts } from "../../shell/src/hooks/useCatalogAppShortcuts";
import { useDesktopConfigStore } from "../../shell/src/stores/desktop-config";
import { useDesktopBootstrap } from "../../shell/src/components/desktop/useDesktopBootstrap";
import { resetWindowManagerLayoutPersistenceForTests, useWindowManager } from "../../shell/src/hooks/useWindowManager";
import { loadWebOsViewState, resetWebOsViewStateClientForTests } from "../../shell/src/lib/os-view-state-client";

import { getGatewayUrl } from "../../shell/src/lib/gateway";

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


it("restores a moved manifest app at the same path used by Gallery and every Web launcher", async () => {
  const bootstrap = bootstrapWithWindows(1);
  bootstrap.layout.windows[0] = { ...bootstrap.layout.windows[0]!, path: "apps/My Finance/Owner Ledger/index.html", title: "Ledger", x: 321 };
  bootstrap.apps = [{ name: "Ledger", path: "/files/apps/My Finance/Owner Ledger/index.html", slug: "folio" } as typeof bootstrap.apps[number]];
  serveBootstrap(bootstrap);
  const { result } = renderHook(() => useDesktopBootstrap({ entryKey: "moved", openWindow: vi.fn() }));
  await waitFor(() => expect(result.current.settled).toBe(true));
  expect(useWindowManager.getState().windows).toHaveLength(1);
  expect(useWindowManager.getState().windows[0]).toMatchObject({ path: "apps/folio/index.html", title: "Ledger", x: 321 });
});


it("keeps a saved manifest identity when another app occupies the old physical folder", async () => {
  const bootstrap = bootstrapWithWindows(1);
  bootstrap.layout.windows[0] = { ...bootstrap.layout.windows[0]!, path: "apps/folio/index.html", title: "Folio" };
  bootstrap.apps = [
    { name: "Folio", path: "/files/apps/finance/ledger/index.html", slug: "folio" },
    { name: "Other", path: "/files/apps/folio/index.html", slug: "other" },
  ] as typeof bootstrap.apps;
  serveBootstrap(bootstrap);
  const { result } = renderHook(() => useDesktopBootstrap({ entryKey: "collision", openWindow: vi.fn() }));
  await waitFor(() => expect(result.current.settled).toBe(true));
  expect(useWindowManager.getState().windows).toHaveLength(1);
  expect(useWindowManager.getState().windows[0]).toMatchObject({ path: "apps/folio/index.html", title: "Folio" });
});


it("projects saved pins and ordering for both Web presentations, including subsequent durable hydration and unpinning", () => {
  const old = "apps/finance/ledger/index.html"; const path = "apps/folio/index.html";
  const catalog = [{ name: "Folio", slug: "folio", path, ownerPath: old }];
  const togglePin = vi.fn(); const previous = useDesktopConfigStore.getState();
  useDesktopConfigStore.setState({ pinnedApps: [old], dockOrder: { userApps: [old] }, togglePin });
  try {
    const { result } = renderHook(() => useCatalogAppShortcuts(catalog));
    expect(result.current.pinnedApps).toEqual([path]);
    expect(result.current.dockOrder?.userApps).toEqual([path]);
    expect(useDesktopConfigStore.getState().pinnedApps).toEqual([old]);
    act(() => useDesktopConfigStore.getState().setPinnedApps(["__terminal__", old]));
    expect(result.current.pinnedApps).toEqual(["__terminal__", path]);
    act(() => result.current.togglePin(path));
    expect(togglePin).toHaveBeenCalledWith(old);
  } finally { useDesktopConfigStore.setState(previous); }
});

it("keeps saved manifest pins when another app reuses the old folder and follows refreshed physical aliases", () => {
  const canonical = "apps/folio/index.html"; const old = "apps/finance/ledger/index.html";
  const previous = useDesktopConfigStore.getState();
  useDesktopConfigStore.setState({ pinnedApps: [canonical], dockOrder: { userApps: [canonical] } });
  try {
    const { result, rerender } = renderHook(({ catalog }) => useCatalogAppShortcuts(catalog), { initialProps: { catalog: [
      { name: "Folio", slug: "folio", path: canonical, ownerPath: old },
      { name: "Other", slug: "other", path: "apps/other/index.html", ownerPath: canonical },
    ] } });
    expect(result.current.pinnedApps).toEqual([canonical]);
    act(() => useDesktopConfigStore.getState().setPinnedApps(["apps/new-ledger/index.html"]));
    rerender({ catalog: [{ name: "Folio", slug: "folio", path: canonical, ownerPath: "apps/new-ledger/index.html" }] });
    expect(result.current.pinnedApps).toEqual([canonical]);
  } finally { useDesktopConfigStore.setState(previous); }
});


it("does not add a second Desktop placement for a moved app and keeps the owner's saved reference and coordinates", async () => {
  const old = "apps/finance/ledger/index.html";
  const path = "apps/folio/index.html";
  const previous = useDesktopConfigStore.getState();
  const placement = { path: old, x: 321, y: 147 };
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ config: {} }) });
  vi.stubGlobal("fetch", fetchMock);
  useDesktopConfigStore.getState().setDesktopIcons([placement]);
  try {
    const { result } = renderHook(() => useCatalogAppShortcuts([{ name: "Folio", slug: "folio", path, ownerPath: old }]));
    const add = result.current.addDesktopIcon;
    let outcome: string | undefined;
    await act(async () => { outcome = await add(path); });
    expect(outcome).toBe("already-present");
    expect(useDesktopConfigStore.getState().desktopIcons).toEqual([placement]);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { useDesktopConfigStore.setState(previous); }
});


it("keeps canonical identity priority when adding another app that reused the saved folder", async () => {
  const path = "apps/folio/index.html";
  const previous = useDesktopConfigStore.getState();
  const saved = { path, x: 321, y: 147 };
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ config: {} }) });
  vi.stubGlobal("fetch", fetchMock);
  useDesktopConfigStore.getState().setDesktopIcons([saved]);
  try {
    const { result } = renderHook(() => useCatalogAppShortcuts([
      { name: "Folio", slug: "folio", path, ownerPath: "apps/finance/ledger/index.html" },
      { name: "Other", slug: "other", path: "apps/other/index.html", ownerPath: path },
    ]));
    await act(async () => {
      expect(await result.current.addDesktopIcon(path)).toBe("already-present");
      expect(await result.current.addDesktopIcon("apps/other/index.html")).toBe("added");
    });
    expect(useDesktopConfigStore.getState().desktopIcons).toContainEqual(saved);
    expect(useDesktopConfigStore.getState().desktopIcons).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally { useDesktopConfigStore.setState(previous); }
});

it("retains coalesced pending add failures through the catalog adapter", async () => {
  const previous = useDesktopConfigStore.getState();
  let resolvePatch!: (response: { ok: boolean; status: number }) => void;
  const response = new Promise<{ ok: boolean; status: number }>(resolve => { resolvePatch = resolve; });
  const fetchMock = vi.fn(() => response);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  useDesktopConfigStore.getState().setDesktopIcons([]);
  try {
    const path = "apps/folio/index.html";
    const { result } = renderHook(() => useCatalogAppShortcuts([{ name: "Folio", slug: "folio", path }]));
    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => { first = result.current.addDesktopIcon(path); second = result.current.addDesktopIcon(path); });
    expect(second).toBe(first);
    await act(async () => {
      resolvePatch({ ok: false, status: 503 });
      expect(await first).toBe("failed");
      expect(await second).toBe("failed");
    });
    expect(useDesktopConfigStore.getState().desktopIcons).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally { useDesktopConfigStore.setState(previous); vi.restoreAllMocks(); }
});


it.each(["apps/folio/index.html", "apps/finance/ledger/index.html"])("deduplicates alias pins and dock ordering and removes every alias in one Unpin through %s", async selected => {
  const canonical = "apps/folio/index.html", old = "apps/finance/ledger/index.html";
  const unrelated = "apps/other/index.html", terminal = "__terminal__";
  const previous = useDesktopConfigStore.getState();
  const placement = { path: old, x: 321, y: 147 };
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ config: {} }) });
  vi.stubGlobal("fetch", fetchMock);
  useDesktopConfigStore.setState({
    pinnedApps: [old, canonical, old, unrelated, terminal],
    dockOrder: { userApps: [old, unrelated, canonical, old], systemApps: [terminal, terminal] },
    desktopIcons: [placement],
  });
  try {
    const { result } = renderHook(() => useCatalogAppShortcuts([{ name: "Folio", slug: "folio", path: canonical, ownerPath: old }]));
    expect(result.current.pinnedApps).toEqual([canonical, unrelated, terminal]);
    expect(result.current.dockOrder).toEqual({ userApps: [canonical, unrelated], systemApps: [terminal] });
    expect(useDesktopConfigStore.getState().pinnedApps).toEqual([old, canonical, old, unrelated, terminal]);
    await act(async () => result.current.togglePin(selected));
    expect(useDesktopConfigStore.getState().pinnedApps).toEqual([unrelated, terminal]);
    expect(result.current.pinnedApps).toEqual([unrelated, terminal]);
    expect(useDesktopConfigStore.getState().desktopIcons).toEqual([placement]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).patch.pinnedApps).toEqual([unrelated, terminal]);
    await act(async () => result.current.togglePin(selected));
    expect(useDesktopConfigStore.getState().pinnedApps).toEqual([unrelated, terminal, canonical]);
    expect(result.current.pinnedApps).toEqual([unrelated, terminal, canonical]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).patch.pinnedApps).toEqual([unrelated, terminal, canonical]);
  } finally { act(() => useDesktopConfigStore.setState(previous)); }
});

it("keeps a concurrent client pin when one Unpin removes every saved manifest alias", async () => {
  const canonical = "apps/folio/index.html", old = "apps/finance/ledger/index.html";
  const local = "apps/local/index.html", remote = "apps/remote/index.html";
  const previous = useDesktopConfigStore.getState();
  const placement = { path: old, x: 321, y: 147 };
  let server = { revision: 1, updatedAt: new Date().toISOString(), document: { ...createDefaultOsViewDocument(), pinnedApps: [old, canonical, local] } };
  const patches: Array<{ baseRevision: number; patch: { pinnedApps: string[] } }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "PATCH") {
      const request = JSON.parse(init.body); patches.push(request);
      if (patches.length === 1) {
        server = { ...server, revision: 2, document: { ...server.document, pinnedApps: [...server.document.pinnedApps, remote] } };
        return new Response("", { status: 409 });
      }
      expect(request.baseRevision).toBe(server.revision);
      server = { ...server, revision: server.revision + 1, document: mergeOsViewStatePatch(server.document, request.patch) };
    }
    return new Response(JSON.stringify(server));
  }));
  useDesktopConfigStore.setState({ pinnedApps: [old, canonical, local], desktopIcons: [placement] });
  try {
    await loadWebOsViewState(getGatewayUrl());
    const { result } = renderHook(() => useCatalogAppShortcuts([{ name: "Folio", slug: "folio", path: canonical, ownerPath: old }]));
    await act(async () => {
      result.current.togglePin(canonical);
      await vi.waitFor(() => expect(patches.length).toBeGreaterThanOrEqual(2));
    });
    expect(server.document.pinnedApps).toEqual([local, remote]);
    expect(patches).toHaveLength(2); // One mutation, retried once after a real revision conflict.
    expect(patches[1].patch.pinnedApps).toEqual([local, remote]);
    expect(useDesktopConfigStore.getState().desktopIcons).toEqual([placement]);
  } finally { act(() => useDesktopConfigStore.setState(previous)); }
});


for (const savedIdentity of [false, true]) {
  it.each(["terminal", "chat", "activity-monitor"])(`restores owner %s without a shell tool collision (saved identity=${savedIdentity})`, async slug => {
    const physical = `apps/tools/my-${slug}/index.html`;
    const identity = `matrix-app:${slug}`;
    const bootstrap = bootstrapWithWindows(1);
    bootstrap.layout.windows[0] = { ...bootstrap.layout.windows[0]!, path: savedIdentity ? identity : physical, title: `Owner ${slug}`, x: 321 };
    bootstrap.apps = [{ name: `Owner ${slug}`, path: `/files/${savedIdentity ? `apps/second-move/${slug}/index.html` : physical}`, slug }] as typeof bootstrap.apps;
    serveBootstrap(bootstrap);
    const { result } = renderHook(() => useDesktopBootstrap({ entryKey: `reserved-${slug}-${savedIdentity}`, openWindow: vi.fn() }));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(useWindowManager.getState().windows).toHaveLength(1);
    expect(useWindowManager.getState().windows[0]).toMatchObject({ path: identity, title: `Owner ${slug}`, x: 321 });
  });
}
