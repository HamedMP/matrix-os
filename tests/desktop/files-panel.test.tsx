// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilesPanel from "../../desktop/src/renderer/src/features/files/FilesPanel";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useEditorTabs } from "../../desktop/src/renderer/src/features/editor/editor-tabs-store";
import { useFileTree } from "../../desktop/src/renderer/src/stores/file-tree";
import { useWorkspace } from "../../desktop/src/renderer/src/stores/workspace";

describe("FilesPanel", () => {
  beforeEach(() => {
    useEditorTabs.setState({
      tabsByTask: {},
      activePathByTask: {},
      dirtyPathsByTask: {},
    });
    useWorkspace.setState({
      layouts: {},
    });
    useFileTree.setState({
      roots: null,
      childrenByPath: {},
      expanded: {},
      loadingRoots: false,
      loadingPaths: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps a failed directory expandable so a later click can retry loading children", async () => {
    const get = vi.fn((path: string) => {
      if (path === "/api/files/list?path=") {
        return Promise.resolve({ entries: [{ name: "src", type: "directory" }] });
      }
      if (path === "/api/files/list?path=src" && get.mock.calls.length === 2) {
        return Promise.reject(new Error("temporary offline"));
      }
      return Promise.resolve({ entries: [{ name: "index.ts", type: "file" }] });
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: { get } as never,
    });

    render(
      <Tooltip.Provider>
        <FilesPanel taskId="task-1" />
      </Tooltip.Provider>,
    );

    const src = await screen.findByRole("button", { name: /src/i });
    fireEvent.click(src);
    await waitFor(() => {
      expect(get).toHaveBeenCalledWith("/api/files/list?path=src");
    });
    expect(screen.queryByText("index.ts")).toBeNull();

    fireEvent.click(src);
    await screen.findByText("index.ts");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("auto-retries root loading when the api reconnects after an initial failure", async () => {
    const offlineGet = vi.fn().mockRejectedValue(new Error("offline"));
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: { get: offlineGet } as never,
    });

    render(
      <Tooltip.Provider>
        <FilesPanel taskId="task-1" />
      </Tooltip.Provider>,
    );

    await waitFor(() => {
      expect(offlineGet).toHaveBeenCalledWith("/api/files/list?path=");
    });

    const onlineGet = vi.fn().mockResolvedValue({ entries: [{ name: "README.md", type: "file" }] });
    await act(async () => {
      useConnection.setState({ api: { get: onlineGet } as never });
    });

    await screen.findByText("README.md");
    expect(onlineGet).toHaveBeenCalledWith("/api/files/list?path=");
  });
});
