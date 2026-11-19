// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilesWorkspace from "../../desktop/src/renderer/src/features/files/FilesWorkspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const removedFile = { name: "delete-me.txt", type: "file" } as const;
const keepFile = { name: "keep-me.txt", type: "file" } as const;
const trashPath = ".trash/delete-me.txt";
const trashEntryId = "9b4e75d8-7b20-44c5-af24-40a31173dfce";

function openFiles(trashEntry: { entryId?: string } = { entryId: trashEntryId }) {
  let trashed = false;
  const get = vi.fn(async (path: string) => path.startsWith("/api/files/list")
    ? { entries: [{ name: "system", type: "directory" }, keepFile, ...(!trashed ? [removedFile] : [])] }
    : { size: 16 });
  const post = vi.fn(async (path: string, _body: unknown, _options?: { signal?: AbortSignal }) => {
    if (path === "/api/files/delete") {
      trashed = true;
      return { ok: true, trashPath, ...trashEntry };
    }
    trashed = false;
    return { ok: true, restoredTo: removedFile.name };
  });
  const api = {
    baseUrl: "https://app.matrix-os.com",
    get,
    getText: vi.fn(async () => "Keep this file."),
    post,
    forRuntime: vi.fn(() => ({ post })),
  };
  useConnection.setState({
    status: "signed-in",
    handle: "operator",
    platformHost: "https://app.matrix-os.com",
    runtimeSlot: "pr-919",
    authGeneration: 1,
    organizationId: null,
    organizationStatus: "none",
    api: api as never,
  });
  render(<Tooltip.Provider><Toaster /><FilesWorkspace /></Tooltip.Provider>);
  return api;
}

async function moveToTrash() {
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Open delete-me.txt" }));
  const item = await screen.findByRole("menuitem", { name: "Move to Trash" });
  fireEvent.click(item);
  const dialog = await screen.findByRole("alertdialog", { name: "Move to Trash" });
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" })); });
}

afterEach(() => {
  cleanup();
  toast.dismiss();
});

describe("Electron Files Trash action", () => {
  it("moves the right-clicked file, preserves its selected sibling and restores it through Undo", async () => {
    const api = openFiles();
    fireEvent.click(await screen.findByRole("button", { name: "Open keep-me.txt" }));
    await screen.findByRole("heading", { name: "keep-me.txt" });
    await moveToTrash();

    await screen.findByText("Moved to Trash");
    expect(await screen.findByRole("button", { name: "Open keep-me.txt" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open delete-me.txt" })).toBeNull());
    expect(screen.getByRole("heading", { name: "keep-me.txt" })).toBeTruthy();
    expect(api.forRuntime).toHaveBeenCalledWith("pr-919");
    expect(api.post).toHaveBeenNthCalledWith(1, "/api/files/delete", { path: removedFile.name, withUndo: true }, expect.any(Object));

    await act(async () => { useConnection.setState({ api: { ...api } as never }); });
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => { fireEvent.click(undo); });
    expect(await screen.findByRole("button", { name: "Open delete-me.txt" })).toBeTruthy();
    expect(api.post).toHaveBeenNthCalledWith(2, "/api/files/trash/restore", { trashPath, entryId: trashEntryId }, expect.any(Object));
  });

  it.each([
    ["missing", {}],
    ["invalid", { entryId: "not-a-uuid" }],
  ])("refreshes the listing and hides Undo when the entry ID is %s", async (_description, trashEntry) => {
    openFiles(trashEntry);
    await moveToTrash();

    expect(await screen.findByText("Moved to Trash")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open delete-me.txt" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("offers navigation without a move action on a managed directory", async () => {
    const api = openFiles();
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Open system" }));
    expect(await screen.findByRole("menuitem", { name: "Open in new tab" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Move to Trash" })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("preserves the listing after a failed move and does not offer Undo", async () => {
    const api = openFiles();
    api.post.mockRejectedValueOnce(new Error("internal gateway failure"));
    await moveToTrash();

    expect(await screen.findByText("Could not move to Trash.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open delete-me.txt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByText("internal gateway failure")).toBeNull();
  });

  it("does not send an Undo to the new computer after switching runtimes", async () => {
    const api = openFiles();
    await moveToTrash();
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => { useConnection.setState({ runtimeSlot: "pr-920" }); });

    if (undo.isConnected) fireEvent.click(undo);
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});
