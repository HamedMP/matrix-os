// @vitest-environment jsdom
import React from "react";
// A signed-in member inside an organization: the conditions under which a file or
// folder share control used to appear beside the selection.
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: "user-test", sessionId: "session-test" }),
  useOrganization: () => ({ organization: { id: "org_matrix_team" } }),
}));
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selection = vi.hoisted(() => ({
  selectedPaths: new Set<string>(),
  entries: [] as Array<{ name: string; type: "file" | "directory" }>,
}));

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
    currentPath: "notes",
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    refresh: vi.fn(),
    get selectedPaths() { return selection.selectedPaths; },
    get entries() { return selection.entries; },
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
    focusedWindowId: "win-files" as string | null,
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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    runtime: { handle: "owner", runtimeSlot: "primary", machineId: "10000000-0000-4000-8000-000000000001" },
    capabilities: { collaboration: true },
  }), { headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FileBrowser offers no standalone file or folder share: projects are the only live-shareable resource", () => {
  for (const entry of [{ name: "plan.md", type: "file" as const }, { name: "private", type: "directory" as const }]) {
    it(`shows no share control for a selected ${entry.type}`, async () => {
      selection.entries = [entry];
      selection.selectedPaths = new Set([entry.name]);
      render(<FileBrowser windowId="win-files" />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

      expect(screen.getByTestId("file-browser-content")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Share\b/i })).toBeNull();
    });
  }
});
