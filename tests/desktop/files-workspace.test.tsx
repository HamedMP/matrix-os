// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilesWorkspace, {
  resolveActivePath,
} from "../../desktop/src/renderer/src/features/files/FilesWorkspace";
import Sidebar from "../../desktop/src/renderer/src/features/mission-control/Sidebar";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const LIST: Record<string, { entries: Array<{ name: string; type: string }> }> = {
  "/api/files/list?path=": {
    entries: [
      { name: "workspaces", type: "directory" },
      { name: "README.md", type: "file" },
    ],
  },
  "/api/files/list?path=workspaces": {
    entries: [
      { name: "hero.png", type: "file" },
      { name: "app.ts", type: "file" },
    ],
  },
};

function makeApi(overrides?: { statFor?: (path: string) => { size?: number } }) {
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/api/files/list?path=")) return LIST[path] ?? { entries: [] };
    if (path.startsWith("/api/files/stat?path=")) {
      return overrides?.statFor ? overrides.statFor(path) : { size: 128 };
    }
    return { entries: [] };
  });
  const getText = vi.fn(async () => "# Matrix files\n\nA remote home you can inspect.");
  const getBlob = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }));
  return { get, getText, getBlob, baseUrl: "https://app.matrix-os.com" };
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
    await waitFor(() => expect(api.getText).toHaveBeenCalledWith("/api/files/blob?path=workspaces%2Fapp.ts"));
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
      expect(api.getBlob).toHaveBeenCalledWith("/api/files/blob?path=workspaces%2Fhero.png"),
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
    act(() => {
      useConnection.setState({ runtimeSlot: "pr-920" });
    });

    expect(await screen.findByText("Choose a file")).not.toBeNull();
    expect(api.getText).not.toHaveBeenCalled();
    expect(api.getBlob).not.toHaveBeenCalled();
    const staleStat = api.get.mock.calls.find(
      ([p]) => String(p).includes("/api/files/stat") && String(p).includes("app.ts"),
    );
    expect(staleStat).toBeUndefined();
  });
});

describe("resolveActivePath", () => {
  it("returns the stored path only when the runtime slot matches", () => {
    expect(resolveActivePath({ slot: "pr-919", path: "workspaces/app.ts" }, "pr-919")).toBe(
      "workspaces/app.ts",
    );
  });

  it("returns null when the stored slot differs from the current slot", () => {
    expect(resolveActivePath({ slot: "pr-919", path: "workspaces/app.ts" }, "pr-920")).toBeNull();
  });

  it("returns null when nothing is selected", () => {
    expect(resolveActivePath(null, "pr-919")).toBeNull();
  });
});
