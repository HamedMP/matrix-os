// @vitest-environment jsdom
import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import FilesWorkspace from "@desktop/renderer/src/features/files/FilesWorkspace";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InspectorFilesPanel } from "@desktop/renderer/src/features/panels/InspectorFilesPanel";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { inspectorFileViewKey, useInspectorFileViews, useFilesNavigation } from "@desktop/renderer/src/stores/files-navigation";

const { download, save } = vi.hoisted(() => ({ download: vi.fn(), save: vi.fn() }));
vi.mock("@desktop/renderer/src/features/files/use-file-download", () => ({ useDesktopFileDownload: () => ({ download, pending: false }) }));
vi.mock("../../packages/ui/src/files/file-image-actions", () => ({ savePreviewBlob: save, copyFileImage: vi.fn() }));
let get: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  useInspectorFileViews.setState({ views: [] });
  get = vi.fn(async (url: string) => url.startsWith("/api/files/search")
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
