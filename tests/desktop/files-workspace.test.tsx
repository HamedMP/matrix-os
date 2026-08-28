// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilesWorkspace, {
  resolveActivePath,
} from "../../desktop/src/renderer/src/features/files/FilesWorkspace";
import { AppError } from "../../desktop/src/renderer/src/lib/errors";
import Sidebar from "../../desktop/src/renderer/src/features/mission-control/Sidebar";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { dispatchActiveAppShortcut } from "../../desktop/src/renderer/src/features/mission-control/app-shortcuts";

const LIST: Record<string, { entries: Array<{ name: string; type: string }> }> = {
  "/api/files/list?path=": {
    entries: [
      { name: "workspaces", type: "directory" },
      { name: "empty", type: "directory" },
      { name: "README.md", type: "file" },
      { name: "archive.zip", type: "file" },
    ],
  },
  "/api/files/list?path=empty": { entries: [] },
  "/api/files/list?path=workspaces": {
    entries: [
      { name: "matrix-os", type: "directory" },
      { name: "hero.png", type: "file" },
      { name: "app.ts", type: "file" },
      { name: "util.ts", type: "file" },
    ],
  },
  "/api/files/list?path=workspaces%2Fmatrix-os": {
    entries: [
      { name: "packages", type: "directory" },
      { name: "package.json", type: "file" },
    ],
  },
  "/api/files/list?path=workspaces%2Fmatrix-os%2Fpackages": {
    entries: [{ name: "gateway", type: "directory" }],
  },
};

interface ApiOverrides {
  statFor?: (path: string) => { size?: number };
  statImpl?: (path: string) => Promise<{ size?: number }>;
  textFor?: (path: string) => string;
}

function makeApi(overrides?: ApiOverrides) {
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/api/files/list?path=")) return LIST[path] ?? { entries: [] };
    if (path.startsWith("/api/files/stat?path=")) {
      if (overrides?.statImpl) return overrides.statImpl(path);
      return overrides?.statFor ? overrides.statFor(path) : { size: 128 };
    }
    return { entries: [] };
  });
  const getText = vi.fn(async (path: string) =>
    overrides?.textFor ? overrides.textFor(path) : "# Matrix files\n\nA remote home you can inspect.",
  );
  const getBlob = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }));
  const post = vi.fn(async () => ({ ok: true }));
  return { get, getText, getBlob, post, baseUrl: "https://app.matrix-os.com" };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Files workspace", () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let objectUrlCounter = 0;
  const createObjectURL = vi.fn(() => `blob:mock/${objectUrlCounter++}`);
  const revokeObjectURL = vi.fn();
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    objectUrlCounter = 0;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL;
    api = makeApi();
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "pr-919",
      authGeneration: 3,
      api: api as never,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("opens from the main navigation as a stable Files tab", () => {
    render(<Tooltip.Provider><Sidebar /></Tooltip.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(useTabs.getState().tabs).toEqual([
      expect.objectContaining({ kind: "files", title: "Files", closable: false }),
    ]);
  });

  it("keeps folders in one pane and opens a selected file in an optional preview", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    const workspaces = await screen.findByRole("button", { name: "Open workspaces" });

    fireEvent.click(workspaces);
    expect(screen.queryByRole("region", { name: "File preview" })).toBeNull();
    expect(screen.getByTestId("files-workspace-panes").getAttribute("data-layout")).toBe("browser");

    fireEvent.doubleClick(workspaces);
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));
    expect(await screen.findByRole("region", { name: "File preview" })).toBeTruthy();
    expect(screen.getByTestId("files-workspace-panes").getAttribute("data-layout")).toBe("preview");
  });

  it("creates and closes Files tabs through active-app shortcuts", async () => {
    render(<Tooltip.Provider><FilesWorkspace active /></Tooltip.Provider>);
    await screen.findByRole("button", { name: "Open workspaces" });

    act(() => expect(dispatchActiveAppShortcut("new-tab")).toBe(true));
    expect(screen.getAllByRole("tab", { name: "Matrix home" })).toHaveLength(2);

    act(() => {
      window.dispatchEvent(new CustomEvent("matrix:active-app-shortcut", {
        cancelable: true,
        detail: "unsupported",
      }));
    });
    expect(screen.getAllByRole("tab", { name: "Matrix home" })).toHaveLength(2);

    act(() => expect(dispatchActiveAppShortcut("close-tab")).toBe(true));
    expect(screen.getAllByRole("tab", { name: "Matrix home" })).toHaveLength(1);
  });

  it("shows the designed empty-folder preview state", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);

    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open empty" }));

    expect(await screen.findByText("This folder is empty.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "File preview" })).toBeNull();
  });

  it("opens a folder in a retained Files tab from its context menu", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    const workspaces = await screen.findByRole("button", { name: "Open workspaces" });

    fireEvent.contextMenu(workspaces);
    fireEvent.click(await screen.findByText("Open in new tab"));

    expect((await screen.findByRole("tab", { name: "workspaces" })).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Matrix home" }).getAttribute("aria-selected")).toBe("false");
    expect(await screen.findByRole("button", { name: "Open app.ts" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Matrix home" }));
    expect(await screen.findByRole("button", { name: "Open README.md" })).toBeTruthy();
  });

  it("creates a folder from the listing context menu and refreshes the active tab", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    await screen.findByRole("button", { name: "Open workspaces" });

    fireEvent.contextMenu(screen.getAllByTestId("files-listing").at(-1)!);
    fireEvent.click(await screen.findByText("New folder…"));
    const folderNameInput = screen.getByRole("textbox", { name: "Folder name" });
    expect(document.activeElement).toBe(folderNameInput);
    fireEvent.change(folderNameInput, { target: { value: "Ideas" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/files/mkdir", { path: "Ideas" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it("keeps folder creation scoped to the tab that opened the dialog", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    const workspaces = await screen.findByRole("button", { name: "Open workspaces" });
    fireEvent.contextMenu(workspaces);
    fireEvent.click(await screen.findByText("Open in new tab"));
    await screen.findByRole("button", { name: "Open app.ts" });

    fireEvent.contextMenu(screen.getAllByTestId("files-listing").at(-1)!);
    fireEvent.click(await screen.findByText("New folder…"));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
      target: { value: "Ideas" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Matrix home", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/files/mkdir",
      { path: "workspaces/Ideas" },
    ));
    await waitFor(() => expect(api.get.mock.calls.filter(
      ([path]) => path === "/api/files/list?path=workspaces",
    )).toHaveLength(2));
    expect(api.get.mock.calls.filter(
      ([path]) => path === "/api/files/list?path=",
    )).toHaveLength(1);
  });

  it("cancels folder creation when the selected computer changes", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    await screen.findByRole("button", { name: "Open workspaces" });

    fireEvent.contextMenu(screen.getByTestId("files-listing"));
    fireEvent.click(await screen.findByText("New folder…"));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
      target: { value: "Ideas" },
    });
    act(() => {
      useConnection.setState({ runtimeSlot: "pr-920" });
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull());
    expect(api.post).not.toHaveBeenCalled();
  });

  it("closes the optional preview without changing the open folder", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));
    expect(await screen.findByRole("region", { name: "File preview" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("region", { name: "File preview" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open app.ts" })).toBeTruthy();
  });

  it("shows an unsupported state without reading unknown file bytes", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: "Open archive.zip" }));

    expect(await screen.findByRole("heading", { name: "Preview not available" })).toBeTruthy();
    expect(screen.getByText("This file type can’t be previewed here.")).toBeTruthy();
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("/api/files/stat"));
    expect(api.getText).not.toHaveBeenCalled();
    expect(api.getBlob).not.toHaveBeenCalled();
  });

  it("distinguishes missing and permission preview failures", async () => {
    const missing = makeApi({
      statImpl: async () => { throw new AppError("notFound", { detail: "not_found" }); },
    });
    useConnection.setState({ api: missing as never });
    const first = render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));
    expect(await screen.findByRole("heading", { name: "File not found" })).toBeTruthy();
    expect(screen.getByText("It may have been moved or deleted.")).toBeTruthy();
    first.unmount();

    const denied = makeApi({
      statImpl: async () => { throw new AppError("unauthorized", { detail: "permission_denied" }); },
    });
    useConnection.setState({ api: denied as never });
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));
    expect(await screen.findByRole("heading", { name: "Permission required" })).toBeTruthy();
    expect(screen.getByText("You don’t have permission to preview this file.")).toBeTruthy();
  });

  it("retries a recoverable preview failure in place", async () => {
    const statImpl = vi.fn()
      .mockRejectedValueOnce(new AppError("server"))
      .mockResolvedValueOnce({ size: 128 });
    const custom = makeApi({ statImpl });
    useConnection.setState({ api: custom as never });
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));

    expect(await screen.findByRole("heading", { name: "Couldn’t load preview" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(/A remote home you can inspect/)).toBeTruthy();
    expect(statImpl).toHaveBeenCalledTimes(2);
  });

  it("browses folders with breadcrumbs and previews markdown", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: "Open README.md" }));
    expect(await screen.findByRole("heading", { name: "Matrix files" })).not.toBeNull();

    fireEvent.doubleClick(screen.getByRole("button", { name: "Open workspaces" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/files/list?path=workspaces"));
    expect(screen.getByRole("button", { name: "Matrix home" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "workspaces" })).not.toBeNull();
  });

  it("previews bounded code as selectable text", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));
    await waitFor(() => expect(api.getText).toHaveBeenCalledWith("/api/files/blob?path=workspaces%2Fapp.ts", { maxBytes: 1024 * 1024 }));
    expect(screen.getByText(/A remote home you can inspect/).closest("pre")).not.toBeNull();
  });

  it("fails closed when a text stat omits a size instead of fetching the full blob", async () => {
    const custom = makeApi({ statFor: () => ({}) });
    useConnection.setState({ api: custom as never });
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));
    expect(await screen.findByText(/too large to preview/i)).not.toBeNull();
    expect(custom.getText).not.toHaveBeenCalled();
  });

  it("previews images through the authenticated api client and revokes the object URL on unmount", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png" }));
    const image = await screen.findByRole("img", { name: "hero.png" });
    await waitFor(() =>
      expect(api.getBlob).toHaveBeenCalledWith("/api/files/blob?path=workspaces%2Fhero.png", { maxBytes: 10 * 1024 * 1024 }),
    );
    const src = image.getAttribute("src") ?? "";
    expect(src).toMatch(/^blob:mock\//);
    expect(src).not.toMatch(/token|bearer/i);
    const created = createObjectURL.mock.results.at(-1)!.value as string;
    cleanup();
    expect(revokeObjectURL).toHaveBeenCalledWith(created);
  });

  it("fails closed when an image stat omits a size instead of fetching the blob", async () => {
    const custom = makeApi({ statFor: () => ({}) });
    useConnection.setState({ api: custom as never });
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png" }));
    expect(await screen.findByText(/too large to preview/i)).not.toBeNull();
    expect(custom.getBlob).not.toHaveBeenCalled();
  });

  it("clears the file preview and issues no stale request when the selected computer changes", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));
    expect(await screen.findByText(/A remote home you can inspect/)).not.toBeNull();

    api.getText.mockClear();
    api.getBlob.mockClear();
    api.get.mockClear();
    await act(async () => {
      useConnection.setState({ runtimeSlot: "pr-920" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "File preview" })).toBeNull();
      expect(screen.getByTestId("files-workspace-panes").getAttribute("data-layout")).toBe("browser");
      expect(api.get).toHaveBeenCalledWith("/api/files/list?path=");
    });
    expect(api.getText).not.toHaveBeenCalled();
    expect(api.getBlob).not.toHaveBeenCalled();
    const staleStat = api.get.mock.calls.find(
      ([p]) => String(p).includes("/api/files/stat") && String(p).includes("app.ts"),
    );
    expect(staleStat).toBeUndefined();
  });

  it("pins the session scope at fetch time even before React commits the switch", async () => {
    let resolveStat!: (value: { size: number }) => void;
    const statPromise = new Promise<{ size: number }>((resolve) => {
      resolveStat = resolve;
    });
    const custom = makeApi({ statImpl: () => statPromise });
    useConnection.setState({ api: custom as never });
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));

    // The store commits the replacement session before React re-renders and
    // runs the effect cleanup; the stat can settle inside that gap, so the
    // cancelled flag alone cannot stop the follow-up blob fetch.
    await act(async () => {
      useConnection.setState({ authGeneration: 4 });
      resolveStat({ size: 128 });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "File preview" })).toBeNull();
    });
    expect(custom.getText).not.toHaveBeenCalled();
  });

  it("does not fetch a text blob against the new computer when the slot changes mid-stat", async () => {
    let resolveStat!: (value: { size: number }) => void;
    const statPromise = new Promise<{ size: number }>((resolve) => {
      resolveStat = resolve;
    });
    const custom = makeApi({ statImpl: () => statPromise });
    useConnection.setState({ api: custom as never });
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));

    // Switch the selected computer while the stat request is still pending.
    act(() => {
      useConnection.setState({ runtimeSlot: "pr-920" });
    });
    await act(async () => {
      resolveStat({ size: 128 });
      await Promise.resolve();
    });

    expect(custom.getText).not.toHaveBeenCalled();
  });

  it("does not fetch an image blob against the new computer when the slot changes mid-stat", async () => {
    let resolveStat!: (value: { size: number }) => void;
    const statPromise = new Promise<{ size: number }>((resolve) => {
      resolveStat = resolve;
    });
    const custom = makeApi({ statImpl: () => statPromise });
    useConnection.setState({ api: custom as never });
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png" }));

    act(() => {
      useConnection.setState({ runtimeSlot: "pr-920" });
    });
    await act(async () => {
      resolveStat({ size: 128 });
      await Promise.resolve();
    });

    expect(custom.getBlob).not.toHaveBeenCalled();
  });

  it("clears the preview when the session identity changes on the same computer", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));
    expect(await screen.findByText(/A remote home you can inspect/)).not.toBeNull();

    api.getText.mockClear();
    api.get.mockClear();
    // Same runtime slot, but a replacement signed-in session (new credential).
    await act(async () => {
      useConnection.setState({ authGeneration: 4 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "File preview" })).toBeNull();
      expect(screen.getByTestId("files-workspace-panes").getAttribute("data-layout")).toBe("browser");
      expect(api.get).toHaveBeenCalledWith("/api/files/list?path=");
    });
    expect(api.getText).not.toHaveBeenCalled();
    const staleStat = api.get.mock.calls.find(
      ([p]) => String(p).includes("/api/files/stat") && String(p).includes("app.ts"),
    );
    expect(staleStat).toBeUndefined();
  });

  it("shows loading for a newly selected file rather than the previous file's content", async () => {
    let resolveSecondStat!: (value: { size: number }) => void;
    const secondStat = new Promise<{ size: number }>((resolve) => {
      resolveSecondStat = resolve;
    });
    const custom = makeApi({
      textFor: (path) => `content of ${path}`,
      statImpl: (path) => (path.includes("util.ts") ? secondStat : Promise.resolve({ size: 128 })),
    });
    useConnection.setState({ api: custom as never });
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));
    expect(
      await screen.findByText("content of /api/files/blob?path=workspaces%2Fapp.ts"),
    ).not.toBeNull();

    // Switch to another text file whose stat has not resolved yet.
    fireEvent.click(screen.getByRole("button", { name: "Open util.ts" }));
    expect(
      screen.queryByText("content of /api/files/blob?path=workspaces%2Fapp.ts"),
    ).toBeNull();
    expect(screen.getByText("Loading preview…")).not.toBeNull();

    await act(async () => {
      resolveSecondStat({ size: 128 });
      await Promise.resolve();
    });
    expect(
      await screen.findByText("content of /api/files/blob?path=workspaces%2Futil.ts"),
    ).not.toBeNull();
  });

  it("enters directories with the keyboard", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    const workspaces = await screen.findByRole("button", { name: "Open workspaces" });

    // Keyboard and screen-reader users cannot double-click; Enter on a
    // directory row must navigate into it.
    fireEvent.keyDown(workspaces, { key: "Enter" });

    expect(await screen.findByRole("button", { name: "Open app.ts" })).not.toBeNull();
  });

  it("hides browser entries loaded under a previous session scope", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open workspaces" })).toBeTruthy());

    // A replacement session can keep the same runtime slot; the previous
    // owner's directory listing must not stay visible or clickable.
    api.get.mockClear();
    api.get.mockResolvedValue({ entries: [] });
    await act(async () => {
      useConnection.setState({ authGeneration: 4 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith("/api/files/list?path=");
      expect(screen.queryByRole("button", { name: "Open workspaces" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Open README.md" })).toBeNull();
    });
  });
});

describe("resolveActivePath", () => {
  it("returns the stored path when slot and auth generation match", () => {
    expect(
      resolveActivePath({ slot: "pr-919", authGeneration: 3, path: "workspaces/app.ts" }, "pr-919", 3),
    ).toBe("workspaces/app.ts");
  });

  it("returns null when the stored slot differs", () => {
    expect(
      resolveActivePath({ slot: "pr-919", authGeneration: 3, path: "workspaces/app.ts" }, "pr-920", 3),
    ).toBeNull();
  });

  it("returns null when the auth generation differs", () => {
    expect(
      resolveActivePath({ slot: "pr-919", authGeneration: 3, path: "workspaces/app.ts" }, "pr-919", 4),
    ).toBeNull();
  });

  it("returns null when nothing is selected", () => {
    expect(resolveActivePath(null, "pr-919", 3)).toBeNull();
  });
});
