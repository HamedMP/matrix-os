// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilesPanel from "../../desktop/src/renderer/src/features/files/FilesPanel";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useEditorTabs } from "../../desktop/src/renderer/src/features/editor/editor-tabs-store";
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

    render(<FilesPanel taskId="task-1" />);

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
});
