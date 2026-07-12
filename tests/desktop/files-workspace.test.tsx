// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilesWorkspace from "../../desktop/src/renderer/src/features/files/FilesWorkspace";
import Sidebar from "../../desktop/src/renderer/src/features/mission-control/Sidebar";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

describe("Files workspace", () => {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/files/list?path=") {
      return { entries: [{ name: "workspaces", type: "directory" }, { name: "README.md", type: "file" }] };
    }
    if (path === "/api/files/list?path=workspaces") {
      return { entries: [{ name: "hero.png", type: "file" }, { name: "app.ts", type: "file" }] };
    }
    if (path.startsWith("/api/files/stat?path=")) return { size: 128 };
    return { entries: [] };
  });
  const getText = vi.fn(async () => "# Matrix files\n\nA remote home you can inspect.");

  beforeEach(() => {
    get.mockClear();
    getText.mockClear();
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "pr-919",
      api: { get, getText, baseUrl: "https://app.matrix-os.com" } as never,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/files/list?path=workspaces"));
    expect(screen.getByRole("button", { name: "Matrix home" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "workspaces" })).not.toBeNull();
  });

  it("previews images from the selected computer without exposing credentials", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png" }));
    const image = await screen.findByRole("img", { name: "hero.png" });
    expect(image.getAttribute("src")).toBe(
      "https://app.matrix-os.com/api/files/blob?path=workspaces%2Fhero.png&runtime=pr-919",
    );
    expect(image.getAttribute("src")).not.toMatch(/token|bearer/i);
  });

  it("previews bounded code as selectable text", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));
    await waitFor(() => expect(getText).toHaveBeenCalledWith("/api/files/blob?path=workspaces%2Fapp.ts"));
    expect(screen.getByText(/A remote home you can inspect/).closest("pre")).not.toBeNull();
  });
});
