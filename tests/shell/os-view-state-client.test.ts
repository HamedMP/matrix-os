import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import {
  importWebLegacyDesktopConfig,
  layoutWindowsFromOsViewState,
  patchWebOsViewState,
  resetWebOsViewStateClientForTests,
} from "../../shell/src/lib/os-view-state-client";

const latest = {
  revision: 4,
  document: createDefaultOsViewDocument(),
  updatedAt: "2026-08-30T12:00:00.000Z",
};

describe("Web OS-view state client", () => {
  beforeEach(() => resetWebOsViewStateClientForTests());

  it("imports only present legacy Desktop fields and caches the returned state", async () => {
    const imported = { ...latest, revision: 2 };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => imported,
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(importWebLegacyDesktopConfig("http://gateway.test", {
      pinnedApps: ["__chat__"],
    })).resolves.toEqual(imported);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://gateway.test/api/os-view-state/import-legacy-desktop");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ pinnedApps: ["__chat__"] });
  });

  it("restores shared open apps from the other presentation when selected geometry is empty", () => {
    const document = createDefaultOsViewDocument();
    document.apps = [
      { path: "__chat__", title: "Chat", state: "open" },
      { path: "__terminal__", title: "Terminal", state: "minimized" },
    ];
    document.desktop.windows = [
      { path: "__chat__", x: 40, y: 60, width: 900, height: 640 },
      {
        path: "__terminal__",
        x: 80,
        y: 100,
        width: 840,
        height: 560,
        terminalLayoutId: "term-layout_0123456789abcdef0123456789abcdef",
      },
    ];

    expect(layoutWindowsFromOsViewState({ ...latest, document }, "canvas")).toEqual([
      { path: "__chat__", title: "Chat", state: "open", x: 40, y: 60, width: 900, height: 640 },
      {
        path: "__terminal__",
        title: "Terminal",
        state: "minimized",
        x: 80,
        y: 100,
        width: 840,
        height: 560,
        terminalLayoutId: "term-layout_0123456789abcdef0123456789abcdef",
      },
    ]);
  });

  it("converts fallback geometry into the selected presentation coordinate space", () => {
    const document = createDefaultOsViewDocument();
    document.apps = [{ path: "__chat__", title: "Chat", state: "open" }];
    document.desktop.windows = [
      { path: "__chat__", x: 40, y: 60, width: 900, height: 640 },
    ];
    document.canvas.transform = { panX: -100, panY: 50, zoom: 0.5 };

    expect(layoutWindowsFromOsViewState({ ...latest, document }, "canvas")).toEqual([
      { path: "__chat__", title: "Chat", state: "open", x: 180, y: 70, width: 1800, height: 1280 },
    ]);

    document.desktop.windows = [];
    document.canvas.windows = [
      { path: "__chat__", x: 180, y: 70, width: 1800, height: 1280 },
    ];
    expect(layoutWindowsFromOsViewState({ ...latest, document }, "desktop")).toEqual([
      { path: "__chat__", title: "Chat", state: "open", x: 40, y: 60, width: 900, height: 640 },
    ]);
  });

  it("reloads and retries the same mutation after a revision conflict", async () => {
    const latestAfterConflict = {
      ...latest,
      document: {
        ...latest.document,
        pinnedApps: ["__terminal__"],
      },
    };
    const afterRetry = { ...latestAfterConflict, revision: 8 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => latestAfterConflict })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => afterRetry })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...afterRetry, revision: 9 }) });
    vi.stubGlobal("fetch", fetchMock);

    await patchWebOsViewState("http://gateway.test", { pinnedApps: ["__chat__"] });
    await patchWebOsViewState("http://gateway.test", { desktop: { icons: [] } });

    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    const retried = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(first.baseRevision).toBe(1);
    expect(retried.baseRevision).toBe(4);
    expect(retried.mutationId).toBe(first.mutationId);
    expect(retried.patch).toEqual({ pinnedApps: ["__terminal__", "__chat__"] });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).baseRevision).toBe(8);
  });

  it("keeps rebasing the pending mutation when the retry also conflicts", async () => {
    const firstLatest = {
      ...latest,
      document: {
        ...latest.document,
        pinnedApps: ["__terminal__"],
      },
    };
    const secondLatest = {
      ...firstLatest,
      revision: 7,
      document: {
        ...firstLatest.document,
        pinnedApps: ["__terminal__", "__file-browser__"],
      },
    };
    const afterRetry = { ...secondLatest, revision: 8 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => firstLatest })
      .mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => secondLatest })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => afterRetry });
    vi.stubGlobal("fetch", fetchMock);

    await patchWebOsViewState("http://gateway.test", { pinnedApps: ["__chat__"] });

    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    const firstRetry = JSON.parse(fetchMock.mock.calls[2][1].body);
    const secondRetry = JSON.parse(fetchMock.mock.calls[4][1].body);
    expect(firstRetry.baseRevision).toBe(4);
    expect(secondRetry.baseRevision).toBe(7);
    expect(firstRetry.mutationId).toBe(first.mutationId);
    expect(secondRetry.mutationId).toBe(first.mutationId);
    expect(secondRetry.patch).toEqual({
      pinnedApps: ["__terminal__", "__file-browser__", "__chat__"],
    });
  });

  it("bounds conflict retries so a contended mutation cannot block the queue", async () => {
    const revisions = [4, 5, 6].map((revision) => ({ ...latest, revision }));
    const fetchMock = vi.fn();
    for (const revision of revisions) {
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 409 })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => revision });
    }
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409 });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...latest, revision: 8 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(patchWebOsViewState("http://gateway.test", { pinnedApps: ["__chat__"] }))
      .rejects.toThrow("conflicted repeatedly");
    await patchWebOsViewState("http://gateway.test", { desktop: { icons: [] } });

    expect(JSON.parse(fetchMock.mock.calls[7][1].body).baseRevision).toBe(6);
  });
});
