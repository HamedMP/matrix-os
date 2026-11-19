// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilesWorkspace from "../../desktop/src/renderer/src/features/files/FilesWorkspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { AppError } from "../../desktop/src/shared/app-error";

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
  await act(async () => { fireEvent.click(item); });
}

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.restoreAllMocks();
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

  it.each([
    [new TypeError("private gateway token at /home/owner"), "offline"],
    [new AppError("timeout", { cause: new DOMException("private timeout", "TimeoutError") }), "timeout"],
    [Object.assign(new Error("private gateway failure"), { name: "/home/owner/private-token" }), "server"],
  ])("keeps move failures generic and logs only their safe category %s", async (failure, category) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = openFiles();
    api.post.mockRejectedValueOnce(failure);
    await moveToTrash();

    expect(await screen.findByText("Could not move to Trash.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open delete-me.txt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(warning).toHaveBeenCalledExactlyOnceWith("[files-trash] Request failed", { operation: "move", category });
  });

  it.each([
    new DOMException("private cancellation", "AbortError"),
    new AppError("timeout", { cause: new DOMException("private cancellation", "AbortError") }),
  ])("silences direct and API-wrapped cancellation and releases the pending move", async (failure) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorToast = vi.spyOn(toast, "error");
    const api = openFiles();
    api.post.mockRejectedValueOnce(failure);
    await moveToTrash();
    expect(errorToast).not.toHaveBeenCalled();
    expect(screen.queryByText("Could not move to Trash.")).toBeNull();
    expect(screen.getByRole("button", { name: "Open delete-me.txt" })).toBeTruthy();
    expect(warning).not.toHaveBeenCalled();
    await moveToTrash();
    expect(await screen.findByText("Moved to Trash")).toBeTruthy();
  });

  it("logs a safe restore failure while keeping the item in Trash", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = openFiles();
    await moveToTrash();
    api.post.mockRejectedValueOnce(new AppError("unauthorized", { cause: new Error("private provider credentials") }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(await screen.findByText("Could not restore from Trash.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open delete-me.txt" })).toBeNull();
    expect(warning).toHaveBeenCalledExactlyOnceWith("[files-trash] Request failed", { operation: "restore", category: "unauthorized" });
  });

  it("ignores a rejected move after its runtime authority changes", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = openFiles();
    let reject!: (error: Error) => void;
    api.post.mockImplementationOnce(() => new Promise<never>((_resolve, fail) => { reject = fail; }));
    await moveToTrash();
    await act(async () => { useConnection.setState({ runtimeSlot: "pr-920" }); });
    await act(async () => { reject(new Error("stale private failure")); });
    expect(screen.queryByText("Could not move to Trash.")).toBeNull();
    expect(screen.queryByText("Moved to Trash")).toBeNull();
    expect(warning).not.toHaveBeenCalled();
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
