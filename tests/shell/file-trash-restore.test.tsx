// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileBrowserContent } from "../../shell/src/components/file-browser/FileBrowserContent";
import { TrashView } from "../../shell/src/components/file-browser/TrashView";
import { useFileBrowser } from "../../shell/src/hooks/useFileBrowser";
import { usePreviewWindow } from "../../shell/src/hooks/usePreviewWindow";
import { getGatewayUrl } from "../../shell/src/lib/gateway";

const fixture = { name: "QA-3487", type: "directory" as const };
const trashed = { ...fixture, originalPath: "projects/QA-3487", trashPath: ".trash/fixture", deletedAt: "2026-01-01" };

function FilesAndTrash() {
  const [showingTrash, setShowingTrash] = useState(true);
  return (
    <>
      <button onClick={() => setShowingTrash(false)}>Back to Files</button>
      {showingTrash ? <TrashView gatewayUrl={getGatewayUrl()} /> :
        <FileBrowserContent renamingPath={null} onStartRename={() => {}} onCancelRename={() => {}} />}
    </>
  );
}

function mockGateway(options: { restore?: Promise<Response>; listing?: Promise<Response> } = {}) {
  let trashedEntries = [trashed];
  const fetcher = vi.fn(async (input: string, _init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/api/files/trash/restore")) {
      const result = await (options.restore ?? Promise.resolve(Response.json({ ok: true })));
      if (result.ok) trashedEntries = [];
      return result;
    }
    if (url.pathname.endsWith("/api/files/trash")) return Response.json({ entries: trashedEntries });
    if (url.pathname.endsWith("/api/files/list")) return options.listing ?? Response.json({ entries: [fixture] });
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/vm/review");
  usePreviewWindow.getState().setDraftAuthority("account:session:preview");
  useFileBrowser.setState({ viewMode: "icon", currentPath: "projects", entries: [], loading: false, error: null });
});

afterEach(() => {
  cleanup();
  usePreviewWindow.getState().setDraftAuthority(null);
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
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
