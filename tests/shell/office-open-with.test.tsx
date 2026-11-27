// @vitest-environment jsdom
import React from "react";
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "user-test", sessionId: "session-test" }) }));
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_REQUEST_KV_KEY, parseOpenRequest } from "../../packages/contracts/src/office-open-with";
import { decodeBridgeStoredValue } from "../../shell/src/lib/os-bridge";

const store = vi.hoisted(() => ({
  currentPath: "Documents",
  history: [""],
  historyIndex: 0,
  viewMode: "list",
  sortBy: "name",
  sortDirection: "asc",
  showPreviewPanel: false,
  sidebarCollapsed: false,
  entries: [] as Array<Record<string, unknown>>,
  loading: false,
  error: null as string | null,
  selectedPaths: new Set<string>(),
  lastSelectedPath: null as string | null,
  favorites: [] as string[],
  quickLookPath: null as string | null,
  searchQuery: "",
  searchResults: null as unknown,
  searching: false,
  clipboard: null as unknown,
  pendingView: null as "files" | "trash" | null,
  pendingFolder: null,
  navigate: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), refresh: vi.fn(),
  setViewMode: vi.fn(), setSortBy: vi.fn(), setSortDirection: vi.fn(),
  togglePreviewPanel: vi.fn(), toggleSidebar: vi.fn(), select: vi.fn(), selectAll: vi.fn(),
  clearSelection: vi.fn(), setQuickLookPath: vi.fn(), search: vi.fn(), clearSearch: vi.fn(),
  copy: vi.fn(), cut: vi.fn(), paste: vi.fn(), rename: vi.fn(), deleteFiles: vi.fn(),
  duplicate: vi.fn(), createFolder: vi.fn(), createFile: vi.fn(), toggleFavorite: vi.fn(),
  requestView: vi.fn(), consumeViewRequest: vi.fn(() => true),
}));
vi.mock("@/hooks/useFileBrowser", () => ({
  useFileBrowser: (selector: (value: typeof store) => unknown) => selector(store),
}));

const preview = vi.hoisted(() => ({ openFile: vi.fn() }));
vi.mock("@/hooks/usePreviewWindow", () => ({
  usePreviewWindow: (selector: (value: typeof preview) => unknown) => selector(preview),
}));

const windowManager = vi.hoisted(() => ({
  windows: [] as Array<{ id: string; path: string; minimized: boolean }>,
  focusedWindowId: "win-files" as string | null,
  openWindow: vi.fn(),
  focusWindow: vi.fn(),
  restoreAndFocusWindow: vi.fn(),
}));
vi.mock("@/hooks/useWindowManager", () => ({
  useWindowManager: Object.assign((selector: (value: typeof windowManager) => unknown) => selector(windowManager), {
    getState: () => windowManager,
  }),
}));
vi.mock("@/hooks/useFileWatcher", () => ({ useFileWatcher: vi.fn() }));

// The listing is replaced by buttons that call the same onOpenFile prop every view uses.
vi.mock("../../shell/src/components/file-browser/FileBrowserContent.js", () => ({
  FileBrowserContent: ({ onOpenFile }: { onOpenFile(path: string): void }) => (
    <div>
      {["Documents/Report.docx", "Documents/Budget.XLSX", "Documents/data.csv", "Documents/notes.txt",
        "Documents/big.csv", "system/logs/usage.csv", ".hermes/export.csv", "agents/plan.docx"].map((path) => (
        <button key={path} type="button" onClick={() => onOpenFile(path)}>{`open ${path}`}</button>
      ))}
    </div>
  ),
}));
vi.mock("../../shell/src/components/file-browser/FileContextMenu.js", () => ({
  FileContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../shell/src/components/file-browser/PreviewPanel.js", () => ({ PreviewPanel: () => null }));
vi.mock("../../shell/src/components/file-browser/QuickLook.js", () => ({ QuickLook: () => null }));

import { FileBrowser } from "../../shell/src/components/file-browser/FileBrowser.js";
import { openFileWithDefaultApp } from "../../shell/src/lib/office-open-with";

interface SentRequest { url: string; init: RequestInit; body: { action: string; app: string; key: string; value: string } }

function stubGateway(answer: (request: SentRequest) => Response | Promise<Response>) {
  const sent: SentRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const request = { url, init, body: JSON.parse(init.body as string) };
    sent.push(request);
    return answer(request);
  });
  vi.stubGlobal("fetch", fetchMock);
  return sent;
}

async function openFromBrowser(path: string, { mobile = false }: { mobile?: boolean } = {}) {
  await act(async () => {
    render(<FileBrowser windowId="win-files" mobile={mobile} />);
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: `open ${path}` }));
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  windowManager.windows = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Files open-with routing", () => {
  it.each([
    ["Documents/Report.docx", "docs", "Docs"],
    ["Documents/Budget.XLSX", "sheets", "Sheets"],
    ["Documents/data.csv", "sheets", "Sheets"],
  ])("writes the open request for %s to %s and then launches that app", async (path, app, title) => {
    const sent = stubGateway(() => {
      // The app is launched only after the request is stored.
      expect(windowManager.openWindow).not.toHaveBeenCalled();
      return Response.json({ ok: true });
    });
    await openFromBrowser(path);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${window.location.origin}/api/bridge/data`);
    expect(sent[0]!.init.method).toBe("POST");
    expect(sent[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(sent[0]!.body).toMatchObject({ action: "write", app, key: OPEN_REQUEST_KV_KEY });
    // The stored value is the envelope readData decodes, holding a fresh, valid request.
    const request = parseOpenRequest(decodeBridgeStoredValue(sent[0]!.body.value), Date.now());
    expect(request).toMatchObject({ path });
    expect(windowManager.openWindow).toHaveBeenCalledExactlyOnceWith(title, `apps/${app}/index.html`, 0);
    expect(preview.openFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens other files in Preview without contacting the data route", async () => {
    const sent = stubGateway(() => Response.json({ ok: true }));
    await openFromBrowser("Documents/notes.txt");
    expect(sent).toHaveLength(0);
    expect(preview.openFile).toHaveBeenCalledExactlyOnceWith("Documents/notes.txt", { authority: expect.any(String) });
    expect(windowManager.openWindow).toHaveBeenCalledExactlyOnceWith("Preview", "__preview-window__", 0);
  });

  it.each([
    ["system/logs/usage.csv"], [".hermes/export.csv"], ["agents/plan.docx"],
  ])("opens %s in Preview because the app file route refuses that subtree", async (path) => {
    const sent = stubGateway(() => Response.json({ ok: true }));
    await openFromBrowser(path);
    expect(sent).toHaveLength(0);
    expect(preview.openFile).toHaveBeenCalledExactlyOnceWith(path, { authority: expect.any(String) });
    expect(windowManager.openWindow).toHaveBeenCalledExactlyOnceWith("Preview", "__preview-window__", 0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens a listed file larger than the app read cap in Preview", async () => {
    store.entries = [{ name: "big.csv", type: "file", size: 25 * 1024 * 1024 }, { name: "data.csv", type: "file", size: 120 }];
    try {
      const sent = stubGateway(() => Response.json({ ok: true }));
      await openFromBrowser("Documents/big.csv");
      expect(sent).toHaveLength(0);
      expect(preview.openFile).toHaveBeenCalledExactlyOnceWith("Documents/big.csv", { authority: expect.any(String) });
      cleanup();
      vi.clearAllMocks();
      // A small listed table still goes to Sheets.
      const again = stubGateway(() => Response.json({ ok: true }));
      await openFromBrowser("Documents/data.csv");
      expect(again).toHaveLength(1);
      expect(windowManager.openWindow).toHaveBeenCalledExactlyOnceWith("Sheets", "apps/sheets/index.html", 0);
    } finally {
      store.entries = [];
    }
  });

  it("falls back to Preview for a text table and shows the shared notification when the write fails", async () => {
    stubGateway(() => Response.json({ error: "Database operation failed" }, { status: 500 }));
    await openFromBrowser("Documents/data.csv");
    expect(preview.openFile).toHaveBeenCalledExactlyOnceWith("Documents/data.csv", { authority: expect.any(String) });
    expect(windowManager.openWindow).toHaveBeenCalledExactlyOnceWith("Preview", "__preview-window__", 0);
    expect(windowManager.openWindow).not.toHaveBeenCalledWith("Sheets", expect.anything(), expect.anything());
    expect(screen.getByRole("alert").textContent).toBe("Sheets could not open data.csv. It opened in Preview instead.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // Web Mobile shows its own foreground stack, not desktop windows, and this
  // stack does not ship Docs or Sheets there: every file keeps Preview.
  it.each([
    ["Documents/Report.docx"], ["Documents/Budget.XLSX"], ["Documents/data.csv"],
  ])("opens %s in Preview on mobile without writing an open request", async (path) => {
    const sent = stubGateway(() => Response.json({ ok: true }));
    await openFromBrowser(path, { mobile: true });
    expect(sent).toHaveLength(0);
    expect(preview.openFile).toHaveBeenCalledExactlyOnceWith(path, { authority: expect.any(String) });
    expect(windowManager.openWindow).toHaveBeenCalledExactlyOnceWith("Preview", "__preview-window__", 0);
    expect(windowManager.openWindow).not.toHaveBeenCalledWith(expect.stringMatching(/^(Docs|Sheets)$/), expect.anything(), expect.anything());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never opens a binary document as text when the handoff fails", async () => {
    stubGateway(() => { throw new TypeError("network down"); });
    await openFromBrowser("Documents/Report.docx");
    expect(preview.openFile).not.toHaveBeenCalled();
    expect(windowManager.openWindow).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Docs could not open Report.docx. Try again in a moment.");
  });
});

describe("openFileWithDefaultApp", () => {
  it("reports no default app for other files and invalid paths", async () => {
    const sent = stubGateway(() => Response.json({ ok: true }));
    const launch = vi.fn();
    await expect(openFileWithDefaultApp("notes.txt", { gatewayUrl: "https://gw.test", launch })).resolves.toEqual({ status: "no-default-app" });
    await expect(openFileWithDefaultApp("../escape.docx", { gatewayUrl: "https://gw.test", launch })).resolves.toEqual({ status: "no-default-app" });
    expect(sent).toHaveLength(0);
    expect(launch).not.toHaveBeenCalled();
  });

  it("uses a fresh nonce for every request so a reopened file is delivered again", async () => {
    const sent = stubGateway(() => Response.json({ ok: true }));
    const launch = vi.fn();
    await openFileWithDefaultApp("a.docx", { gatewayUrl: "https://gw.test", launch });
    await openFileWithDefaultApp("a.docx", { gatewayUrl: "https://gw.test", launch });
    const nonces = sent.map((request) => (decodeBridgeStoredValue(request.body.value) as { nonce: string }).nonce);
    expect(new Set(nonces).size).toBe(2);
    expect(launch).toHaveBeenNthCalledWith(1, "Docs", "apps/docs/index.html");
    expect(sent[0]!.url).toBe("https://gw.test/api/bridge/data");
  });

  it("fails without launching when the launch itself throws", async () => {
    stubGateway(() => Response.json({ ok: true }));
    const result = await openFileWithDefaultApp("t.tsv", { gatewayUrl: "https://gw.test", launch: () => { throw new Error("no window"); } });
    expect(result).toEqual({ status: "failed", app: "sheets" });
  });
});
