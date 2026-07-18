// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../shell/src/components/file-browser/FileBrowserToolbar.js", () => ({
  FileBrowserToolbar: () => null,
}));
vi.mock("../../shell/src/components/file-browser/FileBrowserSidebar.js", () => ({
  FileBrowserSidebar: () => null,
}));
vi.mock("../../shell/src/components/file-browser/FileBrowserContent.js", () => ({
  FileBrowserContent: () => <div data-testid="file-browser-content" />,
}));
vi.mock("../../shell/src/components/file-browser/PreviewPanel.js", () => ({
  PreviewPanel: () => null,
}));
vi.mock("../../shell/src/components/file-browser/SearchResults.js", () => ({
  SearchResults: () => null,
}));
vi.mock("../../shell/src/components/file-browser/TrashView.js", () => ({
  TrashView: () => null,
}));
vi.mock("../../shell/src/components/file-browser/StatusBar.js", () => ({
  StatusBar: () => null,
}));
vi.mock("../../shell/src/components/file-browser/QuickLook.js", () => ({
  QuickLook: () => null,
}));
vi.mock("../../shell/src/components/file-browser/FileContextMenu.js", () => ({
  FileContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useFileBrowser", () => {
  const state = {
    currentPath: "",
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    refresh: vi.fn(),
    selectedPaths: [] as string[],
    entries: [] as unknown[],
    select: vi.fn(),
    selectAll: vi.fn(),
    copy: vi.fn(),
    cut: vi.fn(),
    paste: vi.fn(),
    deleteFiles: vi.fn(),
    duplicate: vi.fn(),
    createFolder: vi.fn(),
    quickLookPath: null,
    setQuickLookPath: vi.fn(),
    togglePreviewPanel: vi.fn(),
    searchResults: null,
    pendingView: null as "files" | "trash" | null,
    consumeViewRequest: vi.fn(),
  };
  return {
    useFileBrowser: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

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

import { FileBrowser } from "../../shell/src/components/file-browser/FileBrowser.js";

describe("FileBrowser session replay privacy", () => {
  it("marks the file listing container with ph-no-capture so file names stay out of recordings", () => {
    render(<FileBrowser windowId="win-files" />);

    const content = screen.getByTestId("file-browser-content");
    expect(content.closest(".ph-no-capture")).not.toBeNull();
  });
});
