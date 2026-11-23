// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileBrowserContent } from "../../shell/src/components/file-browser/FileBrowserContent";
import { FileContextMenu } from "../../shell/src/components/file-browser/FileContextMenu";
import { SearchResults } from "../../shell/src/components/file-browser/SearchResults";
import { TrashView } from "../../shell/src/components/file-browser/TrashView";
import { useFileBrowser } from "../../shell/src/hooks/useFileBrowser";
import { usePreviewWindow } from "../../shell/src/hooks/usePreviewWindow";
import { getGatewayUrl } from "../../shell/src/lib/gateway";

const fixture = { name: "QA-3487", type: "directory" as const };
const searchMatch = { ...fixture, path: "projects/QA-3487", matches: [] };
const trashed = { ...fixture, originalPath: "projects/QA-3487", trashPath: ".trash/fixture", deletedAt: "2026-01-01" };

function FilesAndTrash({ initiallyShowingTrash = true }: { initiallyShowingTrash?: boolean }) {
  const [showingTrash, setShowingTrash] = useState(initiallyShowingTrash);
  const searchResults = useFileBrowser(state => state.searchResults);
  return (
    <>
      <button onClick={() => setShowingTrash(false)}>Back to Files</button>
      {showingTrash ? <TrashView gatewayUrl={getGatewayUrl()} /> : (
        <FileContextMenu>
          <div>{searchResults ? <SearchResults /> :
            <FileBrowserContent renamingPath={null} onStartRename={() => {}} onCancelRename={() => {}} />}</div>
        </FileContextMenu>
      )}
    </>
  );
}

function mockGateway(options: {
  restore?: Promise<Response>;
  listing?: Promise<Response>;
  search?: Promise<Response>;
  initiallyTrashed?: boolean;
} = {}) {
  let trashedEntries = options.initiallyTrashed === false ? [] : [trashed];
  const fetcher = vi.fn(async (input: string, _init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/api/files/trash/restore")) {
      const result = await (options.restore ?? Promise.resolve(Response.json({ ok: true })));
      if (result.ok) trashedEntries = [];
      return result;
    }
    if (url.pathname.endsWith("/api/files/trash")) return Response.json({ entries: trashedEntries });
    if (url.pathname.endsWith("/api/files/list")) return options.listing ?? Response.json({ entries: trashedEntries.length ? [] : [fixture] });
    if (url.pathname.endsWith("/api/files/search")) {
      if (url.searchParams.get("q") !== "QA-3487") return Response.json({ results: [] });
      return options.search ?? Response.json({ results: trashedEntries.length ? [] : [searchMatch] });
    }
    if (url.pathname.endsWith("/api/files/delete")) {
      trashedEntries = [trashed];
      return Response.json({ ok: true });
    }
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/vm/review");
  usePreviewWindow.getState().setDraftAuthority("account:session:preview");
  useFileBrowser.setState({ viewMode: "icon", currentPath: "projects", entries: [], loading: false, error: null, searchQuery: "", searchResults: null, searching: false });
});

afterEach(() => {
  cleanup();
  usePreviewWindow.getState().setDraftAuthority(null);
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("refreshes the same computer's Files listing after a confirmed restore", async () => {
  const fetcher = mockGateway();
  render(<FilesAndTrash />);

  fireEvent.click(await screen.findByRole("button", { name: "Restore QA-3487" }));
  await screen.findByText("Trash is empty");
  fireEvent.click(screen.getByRole("button", { name: "Back to Files" }));

  expect(await screen.findByText("QA-3487")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith(`${getGatewayUrl()}/api/files/list?path=projects`, expect.anything());
});

it("leaves Trash and Files unchanged on a restore conflict", async () => {
  const fetcher = mockGateway({ restore: Promise.resolve(Response.json({ ok: false }, { status: 409 })) });
  render(<FilesAndTrash />);

  fireEvent.click(await screen.findByRole("button", { name: "Restore QA-3487" }));

  expect((await screen.findByRole("alert")).textContent).toContain("Could not restore the item");
  expect(await screen.findByRole("button", { name: "Restore QA-3487" })).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => url.includes("/api/files/list"))).toBe(false);
});

it("discards the Files response when the account changes after restore", async () => {
  let resolveListing!: (response: Response) => void;
  const listing = new Promise<Response>(resolve => { resolveListing = resolve; });
  const fetcher = mockGateway({ listing });
  render(<FilesAndTrash />);

  fireEvent.click(await screen.findByRole("button", { name: "Restore QA-3487" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(`${getGatewayUrl()}/api/files/list?path=projects`, expect.anything()));

  await act(async () => {
    usePreviewWindow.getState().setDraftAuthority("another-account:another-session:preview");
    useFileBrowser.setState({ entries: [{ name: "Current account folder", type: "directory" }], loading: false });
    resolveListing(Response.json({ entries: [fixture] }));
  });

  expect(useFileBrowser.getState().entries.map(entry => entry.name)).toEqual(["Current account folder"]);
});

it("re-runs the active filter after restoring a match", async () => {
  const fetcher = mockGateway();
  useFileBrowser.setState({ searchQuery: "QA-3487", searchResults: [] });
  render(<FilesAndTrash />);

  fireEvent.click(await screen.findByRole("button", { name: "Restore QA-3487" }));
  await screen.findByText("Trash is empty");
  fireEvent.click(screen.getByRole("button", { name: "Back to Files" }));

  expect(await screen.findByRole("button", { name: /QA-3487/ })).toBeTruthy();
  expect(useFileBrowser.getState().searchQuery).toBe("QA-3487");
  expect(fetcher).toHaveBeenCalledWith(`${getGatewayUrl()}/api/files/search?q=QA-3487&content=true`, expect.anything());
});

it("removes a confirmed Move to Trash from the active search results", async () => {
  const fetcher = mockGateway({ initiallyTrashed: false });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  useFileBrowser.setState({ searchQuery: "QA-3487", searchResults: [searchMatch] });
  render(<FilesAndTrash initiallyShowingTrash={false} />);

  fireEvent.contextMenu(screen.getByRole("button", { name: /QA-3487/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));

  expect(await screen.findByText('No files matching "QA-3487"')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith(`${getGatewayUrl()}/api/files/delete`, expect.objectContaining({
    body: JSON.stringify({ path: "projects/QA-3487" }),
  }));
});


it.each(["query", "account", "computer"] as const)("discards a restore search response after the %s changes", async (change) => {
  let resolveSearch!: (response: Response) => void;
  const search = new Promise<Response>(resolve => { resolveSearch = resolve; });
  const fetcher = mockGateway({ search });
  useFileBrowser.setState({ searchQuery: "QA-3487", searchResults: [] });
  render(<FilesAndTrash />);

  fireEvent.click(await screen.findByRole("button", { name: "Restore QA-3487" }));
  await screen.findByText("Trash is empty");
  const request = fetcher.mock.calls.find(([url]) => url === `${getGatewayUrl()}/api/files/search?q=QA-3487&content=true`);
  expect(request).toBeDefined();
  await act(async () => {
    if (change === "query") useFileBrowser.getState().search("new filter");
    if (change === "account") {
      usePreviewWindow.getState().setDraftAuthority("another-account:another-session:preview");
      expect(request?.[1]?.signal?.aborted).toBe(true);
    }
    if (change === "computer") window.history.replaceState(null, "", "/vm/other");
    resolveSearch(Response.json({ results: [searchMatch] }));
  });

  expect(useFileBrowser.getState().searchResults).toEqual([]);
  expect(useFileBrowser.getState().searchQuery).toBe(change === "query" ? "new filter" : "QA-3487");
});

it("keeps regular folder refreshes from repeating the active search", async () => {
  const fetcher = mockGateway();
  useFileBrowser.setState({ searchQuery: "QA-3487", searchResults: [] });

  useFileBrowser.getState().refresh();

  await waitFor(() => expect(useFileBrowser.getState().loading).toBe(false));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(`${getGatewayUrl()}/api/files/list?path=projects`, expect.anything());
});
