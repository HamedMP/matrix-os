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
    window.operator = {
      invoke: vi.fn(async () => ({})),
      on: vi.fn(() => () => undefined),
    };
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

    expect(screen.getByText("Matrix Home")).toBeTruthy();
    expect(screen.getByText("Browse this computer's files. This view is not limited to the selected project.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Open README.md" })).toBeTruthy();
    expect(screen.getByText("Choose a file")).toBeTruthy();
  });

  it("can render a vertical browser-only tree and report file targets to a tab workspace", async () => {
    const onOpenFile = vi.fn();
    render(
      <Tooltip.Provider>
        <InspectorFilesPanel browserOnly forceList onOpenFile={onOpenFile} />
      </Tooltip.Provider>,
    );

    const folder = await screen.findByRole("button", { name: "Expand folder workspaces" });
    fireEvent.click(folder);
    fireEvent.click(await screen.findByRole("button", { name: "Open file workspaces/app.ts" }));

    expect(screen.getByTestId("files-listing").querySelector("[data-files-list-header]")).not.toBeNull();
    expect(screen.getByTestId("files-listing").className).toContain("flex-1");
    expect(screen.getByTestId("files-listing").className).not.toContain("h-52");
    expect(screen.queryByRole("group", { name: "View options" })).toBeNull();
    expect(screen.queryByRole("region", { name: "File preview" })).toBeNull();
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Open file README.md" })).toBeTruthy();
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      kind: "home",
      path: "workspaces/app.ts",
      label: "app.ts",
    }));
  });

  it("finishes loading the Project file tree under React StrictMode", async () => {
    vi.spyOn(window.operator, "invoke").mockResolvedValue({
      directory: { kind: "directory" },
      entries: {
        items: [{ path: "README.md", kind: "file", sizeBytes: 8 }],
        hasMore: false,
        limit: 100,
      },
    });

    render(
      <React.StrictMode>
        <Tooltip.Provider>
          <InspectorFilesPanel
            scope={{ kind: "project", chatId: "chat_project", projectId: "matrix-os", label: "Matrix OS" }}
            browserOnly
            forceList
          />
        </Tooltip.Provider>
      </React.StrictMode>,
    );

    expect(await screen.findByRole("button", { name: "Open file README.md" })).toBeTruthy();
    expect(screen.queryByText("Loading files…")).toBeNull();
  });

  it("expands Project folders inline without replacing the root listing", async () => {
    const onOpenFile = vi.fn();
    const invoke = vi.spyOn(window.operator, "invoke").mockImplementation(async (channel, request) => {
      if (channel !== "runtime:browse-files") throw new Error("Unexpected read");
      const path = (request as { path?: string }).path;
      const cursor = (request as { cursor?: string }).cursor;
      return {
        directory: { kind: "directory", ...(path ? { path } : {}) },
        entries: path
          ? cursor
            ? { items: [{ path: "src/worker.ts", kind: "file", sizeBytes: 8 }], hasMore: false, limit: 100 }
            : {
                items: [{ path: "src/app.ts", kind: "file", sizeBytes: 12 }],
                hasMore: true,
                nextCursor: "filecur_1_61",
                limit: 100,
              }
          : {
              items: [{ path: "src", kind: "directory" }, { path: "README.md", kind: "file", sizeBytes: 8 }],
              hasMore: false,
              limit: 100,
            },
      };
    });

    render(
      <Tooltip.Provider>
        <InspectorFilesPanel
          scope={{ kind: "project", chatId: "chat_project", projectId: "matrix-os", label: "Matrix OS" }}
          browserOnly
          forceList
          onOpenFile={onOpenFile}
        />
      </Tooltip.Provider>,
    );

    const folder = await screen.findByRole("button", { name: "Expand folder src" });
    fireEvent.click(folder);
    fireEvent.click(await screen.findByRole("button", { name: "Open file src/app.ts" }));
    expect(await screen.findByRole("button", { name: "Open file src/worker.ts" })).toBeTruthy();

    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Open file README.md" })).toBeTruthy();
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      kind: "project",
      path: "src/app.ts",
    }));
    expect(invoke).toHaveBeenNthCalledWith(1, "runtime:browse-files", {
      projectId: "matrix-os",
      limit: 100,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "runtime:browse-files", {
      projectId: "matrix-os",
      path: "src",
      limit: 100,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "runtime:browse-files", {
      projectId: "matrix-os",
      path: "src",
      cursor: "filecur_1_61",
      limit: 100,
    });
  });

  it("previews a picked markdown file inside the panel", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Open README.md" }));

    expect(await screen.findByRole(
      "heading",
      { name: "Inspector files" },
      { timeout: 5_000 },
    )).toBeTruthy();
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

  it("browses and reads only relative paths inside the resolved Project worktree", async () => {
    const invoke = vi.spyOn(window.operator, "invoke").mockImplementation(async (channel, request) => {
      if (channel === "runtime:browse-files") {
        const path = (request as { path?: string }).path;
        return {
          directory: { kind: "directory", ...(path ? { path } : {}) },
          entries: {
            items: path
              ? [{ path: "src/app.ts", kind: "file", sizeBytes: 12 }]
              : [{ path: "src", kind: "directory" }],
          },
        };
      }
      if (channel === "runtime:get-file-content") {
        return {
          metadata: {
            path: "src/app.ts",
            kind: "file",
            sizeBytes: 12,
            etag: "etag_project_file",
            updatedAt: "2026-08-28T10:00:00.000Z",
          },
          content: "export {};",
          encoding: "utf8",
          truncated: false,
          limitBytes: 65_536,
        };
      }
      throw new Error(`Unexpected channel ${channel}`);
    });

    render(
      <Tooltip.Provider>
        <InspectorFilesPanel scope={{
          kind: "project",
          chatId: "chat_project",
          projectId: "matrix-os",
          worktreeId: "wt_owned",
          label: "Matrix OS",
        }} />
      </Tooltip.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open folder src" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open file src/app.ts" }));

    await screen.findByText("export {};");
    expect(invoke).toHaveBeenNthCalledWith(1, "runtime:browse-files", {
      projectId: "matrix-os",
      worktreeId: "wt_owned",
      limit: 100,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "runtime:browse-files", {
      projectId: "matrix-os",
      worktreeId: "wt_owned",
      path: "src",
      limit: 100,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "runtime:get-file-content", {
      projectId: "matrix-os",
      worktreeId: "wt_owned",
      path: "src/app.ts",
    });
    for (const [, request] of invoke.mock.calls) {
      expect(request).not.toHaveProperty("root");
      expect(JSON.stringify(request)).not.toContain("/Users/");
    }
  });

  it("navigates back to the parent directory without accepting arbitrary paths", async () => {
    const invoke = vi.spyOn(window.operator, "invoke").mockImplementation(async (channel, request) => {
      if (channel !== "runtime:browse-files") throw new Error("Unexpected read");
      const path = (request as { path?: string }).path;
      return {
        directory: { kind: "directory", ...(path ? { path } : {}) },
        entries: { items: path ? [] : [{ path: "src", kind: "directory" }] },
      };
    });

    render(
      <Tooltip.Provider>
        <InspectorFilesPanel scope={{ kind: "project", chatId: "chat_project", projectId: "matrix-os", label: "Matrix OS" }} />
      </Tooltip.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open folder src" }));
    fireEvent.click(await screen.findByRole("button", { name: "Go to parent folder" }));

    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("runtime:browse-files", {
      projectId: "matrix-os",
      limit: 100,
    }));
  });

  it("suppresses stale browse results after the Chat scope changes", async () => {
    let resolveOld!: (value: unknown) => void;
    const invoke = vi.spyOn(window.operator, "invoke").mockImplementation(async (_channel, request) => {
      if ((request as { projectId: string }).projectId === "old-project") {
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      return {
        directory: { kind: "directory" },
        entries: { items: [{ path: "new.txt", kind: "file", sizeBytes: 1 }] },
      };
    });
    const { rerender } = render(
      <Tooltip.Provider>
        <InspectorFilesPanel scope={{ kind: "project", chatId: "chat_old", projectId: "old-project", label: "Old" }} />
      </Tooltip.Provider>,
    );
    rerender(
      <Tooltip.Provider>
        <InspectorFilesPanel scope={{ kind: "project", chatId: "chat_new", projectId: "new-project", label: "New" }} />
      </Tooltip.Provider>,
    );
    expect(await screen.findByRole("button", { name: "Open file new.txt" })).toBeTruthy();

    await act(async () => resolveOld({
      directory: { kind: "directory" },
      entries: { items: [{ path: "old.txt", kind: "file", sizeBytes: 1 }] },
    }));
    expect(screen.queryByRole("button", { name: "Open file old.txt" })).toBeNull();
  });

  it("suppresses a stale file preview after navigating to another directory", async () => {
    let resolveRead!: (value: unknown) => void;
    vi.spyOn(window.operator, "invoke").mockImplementation(async (channel, request) => {
      if (channel === "runtime:get-file-content") {
        return new Promise((resolve) => { resolveRead = resolve; });
      }
      const path = (request as { path?: string }).path;
      return {
        directory: { kind: "directory", ...(path ? { path } : {}) },
        entries: {
          items: path ? [] : [
            { path: "slow.txt", kind: "file", sizeBytes: 4 },
            { path: "src", kind: "directory" },
          ],
        },
      };
    });
    render(
      <Tooltip.Provider>
        <InspectorFilesPanel scope={{ kind: "project", chatId: "chat_project", projectId: "matrix-os", label: "Matrix OS" }} />
      </Tooltip.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open file slow.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Open folder src" }));
    await screen.findByText("No files.");
    await act(async () => resolveRead({
      metadata: {
        path: "slow.txt",
        kind: "file",
        sizeBytes: 4,
        etag: "etag_slow_file",
        updatedAt: "2026-08-28T10:00:00.000Z",
      },
      content: "slow",
      encoding: "utf8",
      truncated: false,
      limitBytes: 65_536,
    }));

    expect(screen.queryByText("slow")).toBeNull();
  });

  it("shows a fail-closed unavailable state without invoking file IPC", () => {
    const invoke = vi.spyOn(window.operator, "invoke");
    render(
      <Tooltip.Provider>
        <InspectorFilesPanel scope={{ kind: "unavailable", chatId: "chat_missing" }} />
      </Tooltip.Provider>,
    );

    expect(screen.getByText("Files are unavailable for this chat.")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});
