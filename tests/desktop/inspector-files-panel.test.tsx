// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConversationInspector } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationInspector";
import { InspectorFilesPanel } from "../../desktop/src/renderer/src/features/panels/InspectorFilesPanel";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import FilesWorkspace from "../../desktop/src/renderer/src/features/files/FilesWorkspace";
import { inspectorFileViewKey, useInspectorFileViews, useFilesNavigation } from "../../desktop/src/renderer/src/stores/files-navigation";

const { download, save } = vi.hoisted(() => ({ download: vi.fn(), save: vi.fn() }));
vi.mock("@desktop/renderer/src/features/files/use-file-download", () => ({ useDesktopFileDownload: () => ({ download, pending: false }) }));
vi.mock("../../packages/ui/src/files/file-image-actions", () => ({ savePreviewBlob: save, copyFileImage: vi.fn() }));

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
    // Each case starts a fresh navigation session; remount persistence is tested explicitly.
    useInspectorFileViews.setState({ views: [] });
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

  it("reveals and selects the previewed file in its parent folder", async () => {
    const { rerender } = render(<InspectorFilesPanel browserOnly selectedFile={{ kind: "home", path: "workspaces/app.ts", label: "app.ts" }} />);
    const file = await screen.findByRole("button", { name: "Open file workspaces/app.ts" });
    expect(file.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Collapse folder workspaces" })).toBeTruthy();
    rerender(<InspectorFilesPanel browserOnly selectedFile={{ kind: "home", path: "workspaces/hero.png", label: "hero.png" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open file workspaces/hero.png" }).getAttribute("aria-current")).toBe("true"));
    expect(file.getAttribute("aria-current")).toBeNull();
  });

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
    const rootFile = screen.getByRole("button", { name: "Open file README.md" });
    expect(folder.className).toContain("gap-2.5");
    expect(folder.className).toContain("px-2.5");
    expect(folder.className).toContain("py-1.5");
    expect(folder.className).toContain("text-sm");
    expect(folder.className).not.toContain("hover:bg-");
    expect(rootFile.className).toContain("gap-2.5");
    expect(rootFile.className).toContain("px-2.5");
    expect(rootFile.className).toContain("py-1.5");
    expect(rootFile.className).toContain("text-sm");
    expect(rootFile.className).not.toContain("hover:bg-");
    expect(Array.from(folder.querySelectorAll("svg")).every((icon) => icon.getAttribute("width") === "15")).toBe(true);
    expect(rootFile.querySelector("img")?.getAttribute("width")).toBe("15");
    fireEvent.click(folder);
    fireEvent.click(await screen.findByRole("button", { name: "Open file workspaces/app.ts" }));

    expect(screen.getByTestId("files-listing").querySelector("[data-files-list-header]")).not.toBeNull();
    expect(screen.getByTestId("files-listing").className).toContain("flex-1");
    expect(screen.getByTestId("files-listing").className).not.toContain("h-52");
    expect(screen.queryByRole("group", { name: "View options" })).toBeNull();
    expect(screen.queryByRole("region", { name: "File preview" })).toBeNull();
    expect(screen.queryByText("Matrix Home")).toBeNull();
    expect(screen.queryByText("Browse this computer's files. This view is not limited to the selected project.")).toBeNull();
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
    expect(screen.queryByText("Matrix OS")).toBeNull();
    expect(screen.queryByText("Project root")).toBeNull();
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

// File actions and explicit navigation share the same inspector fixtures.
describe("Inspector file actions", () => {
let get: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  useInspectorFileViews.setState({ views: [] });
  get = vi.fn(async (url: string) => url.startsWith("/api/file-previews/directory")
    ? { complete: true, entries: [{ path: "notes/guide.md", kind: "file" }] }
    : url.startsWith("/api/files/search")
    ? { results: [{ path: "notes/guide.md", name: "guide.md", type: "file" }], truncated: false }
    : url.endsWith("path=notes") ? { entries: [{ name: "guide.md", type: "file", size: 10 }] }
      : { entries: [{ name: "notes", type: "directory" }, { name: "README.md", type: "file", size: 10 }] });
  const transport = { get, getBlob: vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([65, 66]).buffer })) };
  useConnection.setState({ ...useConnection.getInitialState(), api: { ...transport, forRuntime: () => transport } as never, runtimeSlot: "primary", authGeneration: 1 }, true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["README.md", "notes"])("offers Files, copy path and download on the %s entry", async (path) => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const navigate = vi.spyOn(useFilesNavigation.getState(), "navigate");
  render(<InspectorFilesPanel scope={{ kind: "home", chatId: "chat" }} browserOnly />);
  fireEvent.contextMenu(await screen.findByRole("button", { name: path === "notes" ? "Expand folder notes" : "Open file README.md" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: `Copy path ${path}` }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
  await waitFor(() => expect(screen.getByRole("menuitem", { name: `Open in Files ${path}` }).hasAttribute("data-disabled")).toBe(false));
  fireEvent.click(screen.getByRole("menuitem", { name: `Open in Files ${path}` }));
  expect(navigate).toHaveBeenCalledWith(path === "notes" ? "notes" : "");
  await waitFor(() => expect(screen.getByRole("menuitem", { name: `Download ${path}` }).hasAttribute("data-disabled")).toBe(false));
  fireEvent.click(screen.getByRole("menuitem", { name: `Download ${path}` }));
  if (path === "notes") await waitFor(() => expect(save).toHaveBeenCalledWith(expect.any(Blob), "notes.zip"));
  else expect(download).toHaveBeenCalledWith(path);
});

it("searches filenames beyond expanded folders and opens a matching file", async () => {
  const openFile = vi.fn();
  render(<InspectorFilesPanel scope={{ kind: "home", chatId: "chat" }} browserOnly onOpenFile={openFile} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), { target: { value: "guide" } });
  fireEvent.click(await screen.findByRole("button", { name: "Open file notes/guide.md" }));
  expect(openFile).toHaveBeenCalledWith({ kind: "home", path: "notes/guide.md", label: "guide.md" });
  expect(get).toHaveBeenCalledWith(expect.stringContaining("/api/files/search?q=guide"), expect.anything());
});

  it("reveals the requested worktree folder in Files without resolving a home path", async () => {
    const invoke = vi.fn(async (channel: string, request: { path?: string }) => {
      if (channel !== "runtime:browse-files") throw new Error("UnexpectedChannel");
      return { directory: { kind: "directory", path: request.path }, entries: { items: request.path === "notes"
        ? [{ kind: "file", path: "notes/guide.md" }] : [{ kind: "directory", path: "notes" }], hasMore: false } };
    });
    Object.defineProperty(window, "operator", { configurable: true, value: { invoke } });
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    act(() => useFilesNavigation.getState().navigateProject({ kind: "project", projectId: "project-one", worktreeId: "wt_one", path: "notes" }, true));
    expect(await screen.findByRole("button", { name: "Open file notes/guide.md" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse folder notes" }).getAttribute("aria-expanded")).toBe("true");
    expect(invoke).toHaveBeenCalledWith("runtime:browse-files", expect.objectContaining({ projectId: "project-one", worktreeId: "wt_one", path: "notes" }));
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining("files-location"));
    fireEvent.click(screen.getByRole("button", { name: "Collapse folder notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Close project-one" }));
    act(() => useFilesNavigation.getState().navigateProject({ kind: "project", projectId: "project-one", worktreeId: "wt_one", path: "notes" }, true));
    expect(await screen.findByRole("button", { name: "Collapse folder notes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse folder notes" }));
    act(() => useFilesNavigation.getState().navigateProject({ kind: "project", projectId: "project-one", worktreeId: "wt_one", path: "notes" }, true));
    expect(await screen.findByRole("button", { name: "Collapse folder notes" })).toBeTruthy();
  });


it("stops project pagination when the computer session changes", async () => {
  const invoke = vi.fn(async () => {
    const old = useConnection.getState().authGeneration === 1;
    if (old) useConnection.setState({ authGeneration: 2 });
    return { directory: { kind: "directory" }, entries: { items: [], hasMore: old, nextCursor: old ? "next" : undefined } };
  });
  Object.defineProperty(window, "operator", { configurable: true, value: { invoke } });
  render(<InspectorFilesPanel scope={{ kind: "project", chatId: "chat", projectId: "project-one", worktreeId: "wt_one", label: "Project" }} browserOnly />);
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  // The replacement tree may start its own request; the old request cannot use its cursor.
  expect(invoke.mock.calls.some((call) => (call as unknown as [string, { cursor?: string }])[1]?.cursor === "next")).toBe(false);
});

it("scopes saved file views by account, computer, chat and worktree, with bounded retention", () => {
  useConnection.setState({ userId: "owner-one" });
  const scope = { kind: "project", chatId: "chat", projectId: "project", worktreeId: "one" };
  const key = inspectorFileViewKey(scope);
  useConnection.setState({ authGeneration: 2 });
  expect(inspectorFileViewKey(scope)).toBe(key);
  expect(inspectorFileViewKey({ ...scope, worktreeId: "two" })).not.toBe(key);
  expect(inspectorFileViewKey({ ...scope, chatId: "another" })).not.toBe(key);
  useConnection.setState({ userId: "owner-two" });
  expect(inspectorFileViewKey(scope)).not.toBe(key);
  useConnection.setState({ userId: "owner-one", runtimeSlot: "another-computer" });
  expect(inspectorFileViewKey(scope)).not.toBe(key);
  for (let i = 0; i < 40; i++) useInspectorFileViews.getState().update(`view-${i}`, { expandedPaths: ["notes"], scrollTop: i });
  expect(useInspectorFileViews.getState().views).toHaveLength(32);
  expect(useInspectorFileViews.getState().views[0]?.key).toBe("view-8");
});

it.each([
  { entries: [] },
  { complete: false, entries: [] },
  { complete: true, entries: [{ path: "notes/link", kind: "symlink" }] },
  { complete: true, entries: Array.from({ length: 1001 }, (_, i) => ({ path: `notes/file-${i}`, kind: "file" })) },
])("does not save a ZIP from an incomplete, unsupported or oversized archive listing", async (listing) => {
  get.mockImplementation(async (url: string) => url.startsWith("/api/file-previews/directory") ? listing : { entries: [{ name: "notes", type: "directory" }] });
  render(<InspectorFilesPanel scope={{ kind: "home", chatId: "archive-check" }} browserOnly />);
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Expand folder notes" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Download notes" }));
  await screen.findByRole("alert");
  expect(save).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledWith(expect.stringContaining("/api/file-previews/directory?"), expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

});
