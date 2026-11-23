// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileDownloadProvider, FileDownloadAction } from "../../shell/src/components/file-browser/FileDownloadProvider";
import { FileBrowserContent } from "../../shell/src/components/file-browser/FileBrowserContent";
import { FileContextMenu } from "../../shell/src/components/file-browser/FileContextMenu";
import { useFileBrowser } from "../../shell/src/hooks/useFileBrowser";

import { XpTilesView } from "../../shell/src/components/file-browser/XpTilesView";
import { ColumnView } from "../../shell/src/components/file-browser/ColumnView";

import { SearchResults } from "../../shell/src/components/file-browser/SearchResults";

const deleteFiles = useFileBrowser.getState().deleteFiles;
const download = vi.fn();
const dispose = vi.fn();
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "user-a", sessionId: "session-a" }) }));
vi.mock("../../shell/src/lib/file-download", () => ({ createBrowserFileDownload: () => ({ download, dispose }) }));

beforeEach(() => {
  download.mockReset();
  download.mockResolvedValue({ status: "handed_off" });
  useFileBrowser.setState({ deleteFiles, currentPath: "projects", selectedPaths: new Set(), entries: [{ name: "binary.zip", type: "file", size: 3 }] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("web Files download UI", () => {
  it("downloads and moves a search match by its exact path", async () => {
    const move = vi.fn();
    useFileBrowser.setState({ deleteFiles: move, searching: false, searchQuery: "archive", searchResults: [{ name: "archive.zip", path: "other/nested/archive.zip", type: "file", matches: [] }] });
    render(<FileDownloadProvider><FileContextMenu><div><SearchResults /></div></FileContextMenu></FileDownloadProvider>);
    const row = screen.getByText("archive.zip");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.objectContaining({ path: "other/nested/archive.zip" })));
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    expect(move).toHaveBeenCalledExactlyOnceWith(["other/nested/archive.zip"]);
  });
  it("moves only the clicked search result when the folder selection is hidden", async () => {
    const move = vi.fn();
    useFileBrowser.setState({
      deleteFiles: move,
      selectedPaths: new Set(["first.txt", "second.txt"]),
      searching: false,
      searchQuery: "first",
      searchResults: [{ name: "first.txt", path: "projects/first.txt", type: "file", matches: [] }],
    });
    render(<FileContextMenu><div><SearchResults /></div></FileContextMenu>);

    fireEvent.contextMenu(screen.getByText("first.txt"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    expect(move).toHaveBeenCalledExactlyOnceWith(["projects/first.txt"]);
  });

  it.each([new Error("secret provider /private/path"), "secret token"])("logs only a safe classification for transport rejection %s", async (error) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    download.mockRejectedValue(error);
    render(<FileDownloadProvider><FileDownloadAction path="projects/binary.zip" /></FileDownloadProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(warn).toHaveBeenCalledWith("[file-download] transport rejected", error instanceof Error ? "error" : "unknown"));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    expect(document.body.textContent).not.toContain("secret");
  });
  it("downloads from XP tiles", async () => {
    render(<FileDownloadProvider><FileContextMenu><div><XpTilesView renamingPath={null} onCancelRename={() => {}} /></div></FileContextMenu></FileDownloadProvider>);
    fireEvent.contextMenu(screen.getByText("binary.zip"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.objectContaining({ path: "projects/binary.zip" })));
  });
  it("downloads and moves an ancestor-column file by the column's path", async () => {
    const move = vi.fn();
    useFileBrowser.setState({ deleteFiles: move });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({ entries:
      new URL(url).searchParams.get("path") === "" ? [{ name: "root.zip", type: "file" }] : [{ name: "nested.zip", type: "file" }],
    }))));
    render(<FileDownloadProvider><FileContextMenu><div><ColumnView /></div></FileContextMenu></FileDownloadProvider>);
    const row = await screen.findByText("root.zip");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.objectContaining({ path: "root.zip" })));
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    expect(move).toHaveBeenCalledExactlyOnceWith(["root.zip"]);
  });
  it("offers an explicit file action with browser handoff feedback", async () => {
    render(<FileDownloadProvider><FileDownloadAction path="projects/binary.zip" size={3} /></FileDownloadProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.objectContaining({ path: "projects/binary.zip" })));
    expect(await screen.findByText("Download sent to your browser. Check or cancel it in your browser’s downloads.")).toBeTruthy();
  });
  it("downloads the context-menu target without changing structural management actions", async () => {
    render(<FileDownloadProvider><FileContextMenu><div data-web-file-path="projects/binary.zip" data-web-file-type="file">binary.zip</div></FileContextMenu></FileDownloadProvider>);
    fireEvent.contextMenu(screen.getByText("binary.zip"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.objectContaining({ path: "projects/binary.zip" })));
  });
  it.each(["icon", "list"] as const)("moves an unselected nested folder from the %s view context menu", async (viewMode) => {
    const move = vi.spyOn(useFileBrowser.getState(), "deleteFiles").mockResolvedValue();
    useFileBrowser.setState({
      viewMode, loading: false,
      entries: [{ name: "QA-3487", type: "directory" }],
      deleteFiles: move,
    });
    render(
      <FileContextMenu>
        <div>
          <FileBrowserContent renamingPath={null} onStartRename={() => {}} onCancelRename={() => {}} />
          <span>Blank listing area</span>
        </div>
      </FileContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText("QA-3487"));
    expect(screen.queryByRole("menuitem", { name: "New Folder" })).toBeNull();
    expect(move).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    expect(move).toHaveBeenCalledExactlyOnceWith(["projects/QA-3487"]);

    fireEvent.contextMenu(screen.getByText("Blank listing area"));
    expect(await screen.findByRole("menuitem", { name: "New Folder" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Move to Trash" })).toBeNull();
  });

  it.each(["icon", "list"] as const)("moves only the selected %s rows captured when the menu opened", async (viewMode) => {
    const move = vi.fn();
    useFileBrowser.setState({
      viewMode,
      loading: false,
      entries: [
        { name: "first", type: "file" },
        { name: "second", type: "file" },
        { name: "third", type: "file" },
      ],
      selectedPaths: new Set(["first", "second"]),
      deleteFiles: move,
    });
    render(
      <FileContextMenu>
        <div>
          <FileBrowserContent renamingPath={null} onStartRename={() => {}} onCancelRename={() => {}} />
        </div>
      </FileContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText("first"));
    const moveToTrash = await screen.findByRole("menuitem", { name: "Move to Trash" });
    act(() => useFileBrowser.getState().selectAll());
    fireEvent.click(moveToTrash);
    expect(move).toHaveBeenCalledExactlyOnceWith(["projects/first", "projects/second"]);
  });

  it("aborts pending preflight when the Files provider unmounts", async () => {
    let signal!: AbortSignal;
    let finish!: (value: unknown) => void;
    download.mockImplementation((input) => { signal = input.signal; return new Promise((resolve) => { finish = resolve; }); });
    const view = render(<FileDownloadProvider><FileDownloadAction path="projects/binary.zip" /></FileDownloadProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ status: "handed_off" }));
    expect(screen.queryByText(/Download sent/)).toBeNull();
  });
});
