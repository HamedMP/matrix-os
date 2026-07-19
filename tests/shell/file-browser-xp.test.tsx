// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared mock of the file-browser zustand store. The XP explorer chrome and the
// classic chrome read from the same store, so navigation assertions prove the
// XP branch reuses the existing actions instead of reimplementing them.
const store = vi.hoisted(() => ({
  currentPath: "agents",
  history: ["", "agents"],
  historyIndex: 1,
  viewMode: "icon" as "icon" | "list" | "column",
  sortBy: "name",
  sortDirection: "asc",
  showPreviewPanel: false,
  sidebarCollapsed: false,
  entries: [
    { name: "hermes", type: "directory", children: 3 },
    { name: "notes.txt", type: "file", size: 2048, modified: "2026-01-01T00:00:00.000Z" },
  ] as Array<Record<string, unknown>>,
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
  navigate: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  refresh: vi.fn(),
  setViewMode: vi.fn(),
  setSortBy: vi.fn(),
  setSortDirection: vi.fn(),
  togglePreviewPanel: vi.fn(),
  toggleSidebar: vi.fn(),
  select: vi.fn(),
  selectAll: vi.fn(),
  clearSelection: vi.fn(),
  setQuickLookPath: vi.fn(),
  search: vi.fn(),
  clearSearch: vi.fn(),
  copy: vi.fn(),
  cut: vi.fn(),
  paste: vi.fn(),
  rename: vi.fn(),
  deleteFiles: vi.fn(),
  duplicate: vi.fn(),
  createFolder: vi.fn(),
  createFile: vi.fn(),
  toggleFavorite: vi.fn(),
}));

vi.mock("@/hooks/useFileBrowser", () => ({
  useFileBrowser: (selector: (value: typeof store) => unknown) => selector(store),
}));

vi.mock("@/hooks/usePreviewWindow", () => {
  const state = { openFile: vi.fn() };
  return {
    usePreviewWindow: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

vi.mock("@/hooks/useWindowManager", () => {
  const state = {
    windows: [] as unknown[],
    openWindow: vi.fn(),
    focusWindow: vi.fn(),
  };
  return {
    useWindowManager: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

vi.mock("@/hooks/useFileWatcher", () => ({
  useFileWatcher: vi.fn(),
}));

// Keep the classic content area and heavyweight overlays out of the tree; the
// XP branch does not render FileBrowserContent at all.
vi.mock("../../shell/src/components/file-browser/FileBrowserContent.js", () => ({
  FileBrowserContent: () => <div data-testid="file-browser-content" />,
}));
vi.mock("../../shell/src/components/file-browser/FileContextMenu.js", () => ({
  FileContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../shell/src/components/file-browser/PreviewPanel.js", () => ({
  PreviewPanel: () => null,
}));
vi.mock("../../shell/src/components/file-browser/SearchResults.js", () => ({
  SearchResults: () => <div data-testid="search-results" />,
}));
vi.mock("../../shell/src/components/file-browser/TrashView.js", () => ({
  TrashView: () => <div data-testid="trash-view" />,
}));
vi.mock("../../shell/src/components/file-browser/QuickLook.js", () => ({
  QuickLook: () => null,
}));

import { FileBrowser } from "../../shell/src/components/file-browser/FileBrowser.js";

describe("FileBrowser Windows XP explorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute("data-theme-style");
    store.currentPath = "agents";
    store.history = ["", "agents"];
    store.historyIndex = 1;
    store.viewMode = "icon";
    store.entries = [
      { name: "hermes", type: "directory", children: 3 },
      { name: "notes.txt", type: "file", size: 2048, modified: "2026-01-01T00:00:00.000Z" },
    ];
    store.selectedPaths = new Set();
    store.searchResults = null;
    store.loading = false;
  });

  // The useThemeStyle hook mirrors data-theme-style via an effect + a
  // MutationObserver whose callbacks are microtasks; flush both inside act.
  async function renderBrowser() {
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(<FileBrowser windowId="win-files" />);
      await Promise.resolve();
    });
    return result;
  }

  it("renders the XP toolbar, address bar, common-tasks pane and status bar under winxp", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    await renderBrowser();

    // Toolbar
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Forward" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Up" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Folders" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Views" })).toBeTruthy();

    // Address bar with Go button
    expect(screen.getByText("Address")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Address" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();

    // Common-tasks pane
    expect(screen.getByRole("button", { name: /File and Folder Tasks/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Other Places/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Details/ })).toBeTruthy();

    // Status bar
    expect(screen.getByText("2 objects")).toBeTruthy();

    // Classic chrome is not rendered in XP mode
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(screen.queryByTestId("file-browser-content")).toBeNull();
  });

  it("wires Back and Up to the same store navigation actions as the classic UI", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    await renderBrowser();
    store.navigate.mockClear(); // drop the mount-time navigate("") call

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(store.goBack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    expect(store.navigate).toHaveBeenCalledWith("");
  });

  it("grays out Forward at the end of history and calls goForward when enabled", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    const { rerender } = await renderBrowser();

    // beforeEach leaves historyIndex at the end of ["", "agents"].
    const disabledForward = screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement;
    expect(disabledForward.disabled).toBe(true);
    fireEvent.click(disabledForward);
    expect(store.goForward).not.toHaveBeenCalled();

    store.historyIndex = 0;
    await act(async () => {
      rerender(<FileBrowser windowId="win-files" />);
      await Promise.resolve();
    });

    const forward = screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement;
    expect(forward.disabled).toBe(false);
    fireEvent.click(forward);
    expect(store.goForward).toHaveBeenCalledTimes(1);
  });

  it("lists the store entries as XP tiles with type and size details", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    await renderBrowser();

    const grid = screen.getByRole("grid", { name: "File list" });
    expect(grid).toBeTruthy();
    expect(within(grid).getByText("hermes")).toBeTruthy();
    expect(within(grid).getByText("notes.txt")).toBeTruthy();
    expect(within(grid).getByText("File Folder")).toBeTruthy();
    expect(within(grid).getByText("TXT File")).toBeTruthy();
    expect(within(grid).getByText("2.0 KB")).toBeTruthy();
  });

  it("opens the XP search box from the toolbar and searches through the store", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    await renderBrowser();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const input = screen.getByRole("textbox", { name: "Search files" });
    fireEvent.change(input, { target: { value: "notes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.search).toHaveBeenCalledWith("notes");
  });

  it("clears the XP search query when the search box is closed", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    await renderBrowser();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    let input = screen.getByRole("textbox", { name: "Search files" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "notes" } });

    // Close via the toolbar toggle: the local query is cleared, not preserved.
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(store.clearSearch).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    input = screen.getByRole("textbox", { name: "Search files" }) as HTMLInputElement;
    expect(input.value).toBe("");

    // Same reset on Escape.
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    input = screen.getByRole("textbox", { name: "Search files" }) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("switches view mode through the Views menu using the store action", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    await renderBrowser();

    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "List" }));
    expect(store.setViewMode).toHaveBeenCalledWith("list");
  });

  it("runs New Folder and Other Places links through the store", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    await renderBrowser();
    store.navigate.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "New Folder" }));
    expect(store.createFolder).toHaveBeenCalledWith("New Folder");

    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(store.navigate).toHaveBeenCalledWith("system");
  });

  it("navigates via the address bar Go button", async () => {
    document.documentElement.setAttribute("data-theme-style", "winxp");
    await renderBrowser();
    store.navigate.mockClear();

    const input = screen.getByRole("textbox", { name: "Address" });
    fireEvent.change(input, { target: { value: "system/themes" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(store.navigate).toHaveBeenCalledWith("system/themes");
  });

  it("renders the unchanged classic UI for non-XP designs", async () => {
    document.documentElement.setAttribute("data-theme-style", "flat");
    await renderBrowser();

    // Classic chrome
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByTestId("file-browser-content")).toBeTruthy();
    expect(screen.getByText(/2 items/)).toBeTruthy();

    // No XP chrome
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByText("Address")).toBeNull();
    expect(screen.queryByText("File and Folder Tasks")).toBeNull();
    expect(screen.queryByText("2 objects")).toBeNull();
  });
});
