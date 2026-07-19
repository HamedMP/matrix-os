// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConversationInspector } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationInspector";
import { InspectorFilesPanel } from "../../desktop/src/renderer/src/features/panels/InspectorFilesPanel";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

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

function makeApi() {
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/api/files/list?path=")) return LIST[path] ?? { entries: [] };
    if (path.startsWith("/api/files/stat?path=")) return { size: 128 };
    return { entries: [] };
  });
  const getText = vi.fn(async () => "# Inspector files\n\nPreview from the panel.");
  const getBlob = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }));
  return { get, getText, getBlob, baseUrl: "https://app.matrix-os.com" };
}

describe("AgentConversationInspector Files tab", () => {
  afterEach(cleanup);

  it("renders Files between Changes and Terminal with arrow-key navigation", () => {
    render(
      <AgentConversationInspector
        defaultTab="changes"
        counts={{ changes: 2, terminal: 1, preview: 3, activity: 4 }}
        toolbar={<div>Tools</div>}
        changes={<div>Changed files</div>}
        files={<div>Project files</div>}
        terminal={<div>Matrix shell</div>}
        preview={<div>Preview sessions</div>}
        activity={<div>Workspace activity</div>}
      />,
    );

    // Files carries no numeric badge — it is a browser, not an inbox.
    const filesTab = screen.getByRole("tab", { name: "Files" });
    expect(filesTab.getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByText("Project files")).toBeNull();

    const changes = screen.getByRole("tab", { name: "Changes 2" });
    changes.focus();
    fireEvent.keyDown(changes, { key: "ArrowRight" });

    expect(document.activeElement).toBe(filesTab);
    expect(filesTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Project files")).toBeTruthy();

    fireEvent.keyDown(filesTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Terminal 1" }));
  });

  it("keeps the four-tab layout when no files surface is provided", () => {
    render(
      <AgentConversationInspector
        defaultTab="changes"
        counts={{ changes: 2, terminal: 1, preview: 3, activity: 4 }}
        toolbar={<div>Tools</div>}
        changes={<div>Changed files</div>}
        terminal={<div>Matrix shell</div>}
        preview={<div>Preview sessions</div>}
        activity={<div>Workspace activity</div>}
      />,
    );

    expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
    const changes = screen.getByRole("tab", { name: "Changes 2" });
    changes.focus();
    fireEvent.keyDown(changes, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Terminal 1" }));
  });

  it("shows the files count badge only when a count is provided", () => {
    render(
      <AgentConversationInspector
        defaultTab="files"
        counts={{ changes: 0, files: 7, terminal: 0, preview: 0, activity: 0 }}
        toolbar={<div>Tools</div>}
        changes={<div>Changed files</div>}
        files={<div>Project files</div>}
        terminal={<div>Matrix shell</div>}
        preview={<div>Preview sessions</div>}
        activity={<div>Workspace activity</div>}
      />,
    );

    expect(screen.getByRole("tab", { name: "Files 7" })).toBeTruthy();
  });
});

describe("InspectorFilesPanel", () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock/1") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    api = makeApi();
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: api as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  function renderPanel() {
    return render(
      <Tooltip.Provider>
        <InspectorFilesPanel />
      </Tooltip.Provider>,
    );
  }

  it("opens with the browser and a preview placeholder", async () => {
    renderPanel();

    expect(await screen.findByRole("button", { name: "Open README.md" })).toBeTruthy();
    expect(screen.getByText("Choose a file")).toBeTruthy();
  });

  it("previews a picked markdown file inside the panel", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Open README.md" }));

    expect(await screen.findByRole("heading", { name: "Inspector files" })).toBeTruthy();
  });

  it("previews a picked text file within the 1 MB cap", async () => {
    renderPanel();
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open app.ts" }));

    await waitFor(() =>
      expect(api.getText).toHaveBeenCalledWith("/api/files/blob?path=workspaces%2Fapp.ts", { maxBytes: 1024 * 1024 }),
    );
    expect((await screen.findByText(/Preview from the panel/)).closest("pre")).not.toBeNull();
  });

  it("previews a picked image through the authenticated client within the 10 MB cap", async () => {
    renderPanel();
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png" }));

    const image = await screen.findByRole("img", { name: "hero.png" });
    await waitFor(() =>
      expect(api.getBlob).toHaveBeenCalledWith("/api/files/blob?path=workspaces%2Fhero.png", { maxBytes: 10 * 1024 * 1024 }),
    );
    expect(image.getAttribute("src")).toBe("blob:mock/1");
  });

  it("clears the preview when the selected computer changes", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Open README.md" }));
    expect(await screen.findByRole("heading", { name: "Inspector files" })).toBeTruthy();

    api.getText.mockClear();
    act(() => {
      useConnection.setState({ runtimeSlot: "pr-999" });
    });

    expect(await screen.findByText("Choose a file")).toBeTruthy();
    expect(api.getText).not.toHaveBeenCalled();
  });
});
