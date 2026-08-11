// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { FILE_MOVE_MIME } from "@desktop/renderer/src/features/files/file-drag";
import { AppError } from "@desktop/renderer/src/lib/errors";
import { MoveFilesDialog } from "@desktop/renderer/src/features/files/MoveFilesDialog";
import {
  deferred, dragTransfer, folderListing, installMoveApi, makeApi,
  openMoveFor, renderBrowser, startArchiveMove,
} from "./files-move-test-fixture";

describe("Files move UI", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
    installMoveApi(api);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens an accessible directory-only Move to picker and cancels without transport", async () => {
    renderBrowser({ selectionPlatform: "mac" });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    await openMoveFor("note.md");

    expect(screen.getByRole("heading", { name: "Move 1 item" })).not.toBeNull();
    expect(await screen.findByRole("button", { name: "Choose Archive" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open note.md" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New File" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel move" }));
    expect(screen.queryByRole("heading", { name: "Move 1 item" })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("reports picker candidates to the serializable move session", async () => {
    const chooseCandidate = vi.fn();
    const controls = (destination: string | null) => ({
      session: {
        origin: "menu", stage: "picking", sources: ["note.md"], destination,
        preflight: null, choices: [], applyToRemaining: false,
      },
      chooseCandidate,
      cancelMove: vi.fn(),
      chooseDestination: vi.fn(),
      setApplyToRemaining: vi.fn(),
      chooseConflict: vi.fn(),
      confirmMove: vi.fn(),
    });
    const view = render(<MoveFilesDialog controls={controls(null) as never} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose Archive" }));

    expect(chooseCandidate).toHaveBeenCalledWith("Archive");
    expect(screen.getByRole("button", { name: "Move" }).hasAttribute("disabled")).toBe(true);
    view.rerender(<MoveFilesDialog controls={controls("Archive") as never} />);
    expect((await screen.findByRole("button", { name: "Choose Archive" })).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Move" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows a safe picker listing error and retries instead of appearing empty", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: "Open note.md" }));
    api.setListingError("", new Error("provider /home/operator unavailable"));
    await openMoveFor("note.md");

    expect((await screen.findByRole("alert")).textContent).toBe("Folders could not be loaded.");
    expect(screen.queryByText(/provider|\/home\/operator/i)).toBeNull();
    expect(screen.queryByText("No subfolders here.")).toBeNull();
    api.setListingError("", null);
    fireEvent.click(screen.getByRole("button", { name: "Retry folders" }));
    expect(await screen.findByRole("button", { name: "Choose Archive" })).not.toBeNull();
  });

  it("keeps the newest picker folder when listing responses arrive out of order", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: "Open note.md" }));
    await openMoveFor("note.md");
    const archive = deferred<ReturnType<typeof folderListing>>();
    const home = deferred<ReturnType<typeof folderListing>>();
    api.queueListing("Archive", archive.promise);
    api.queueListing("", home.promise);

    fireEvent.doubleClick(await screen.findByRole("button", { name: "Choose Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Matrix home" }));
    home.resolve(folderListing("", ["Home only"]));
    await act(async () => { await home.promise; });
    expect(await screen.findByRole("button", { name: "Choose Home only" })).not.toBeNull();

    archive.resolve(folderListing("Archive", ["Stale folder"]));
    await act(async () => { await archive.promise; });
    expect(screen.queryByRole("button", { name: "Choose Stale folder" })).toBeNull();
    expect(screen.getByRole("button", { name: "Choose Home only" })).not.toBeNull();
  });

  it("offers the same Move to picker from the row context menu", async () => {
    renderBrowser();
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Open note.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    expect(screen.getByRole("heading", { name: "Move 1 item" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel move" }));
  });

  it("navigates picker breadcrumbs and executes one no-conflict batch with the preflight identity", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: "Open note.md" }));
    await openMoveFor("note.md");

    const archive = await screen.findByRole("button", { name: "Choose Archive" });
    fireEvent.doubleClick(archive);
    expect(await screen.findByRole("button", { name: "Choose Nested" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Archive" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Up one level" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose Archive" }));
    expect(screen.getByRole("button", { name: "Move" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    const preflight = api.post.mock.calls[0]![1] as Record<string, unknown>;
    const execute = api.post.mock.calls[1]![1] as Record<string, unknown>;
    expect(preflight).toMatchObject({ phase: "preflight", sources: ["note.md"], destinationDirectory: "Archive" });
    expect(execute).toEqual({
      phase: "execute",
      requestId: preflight.requestId,
      preflightFingerprint: "move-fingerprint",
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Move 1 item" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Open note.md" })).toBeNull();
  });

  it("explains and rejects source and descendant picker destinations before preflight", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: "Open Folder" }));
    await openMoveFor("Folder");

    fireEvent.click(await screen.findByRole("button", { name: "Choose Folder" }));
    expect(screen.getByRole("alert").textContent).toMatch(/outside the selected folder/i);
    expect(screen.getByRole("button", { name: "Move" }).hasAttribute("disabled")).toBe(true);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Choose Folder" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose Child" }));
    expect(screen.getByRole("alert").textContent).toMatch(/outside the selected folder/i);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("resolves conflicts in source order and applies one allowed choice to remaining rows", async () => {
    api.setConflicts(["note.md", "todo.md"]);
    renderBrowser({ selectionPlatform: "mac" });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    const todo = screen.getByRole("button", { name: "Open todo.md" });
    fireEvent.click(note);
    fireEvent.click(todo, { metaKey: true });
    await startArchiveMove("todo.md");

    expect(await screen.findByRole("heading", { name: "Resolve move conflicts" })).not.toBeNull();
    expect(screen.getAllByTestId("move-conflict-source").map((row) => row.textContent)).toEqual(["note.md", "todo.md"]);
    expect(screen.queryByText(/overwrite|merge/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip todo.md" }));
    expect(screen.getByRole("button", { name: "Skip todo.md" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "Apply to remaining conflicts" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep Both for note.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected items" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[1]![1]).toMatchObject({
      phase: "execute",
      conflictChoices: [
        { source: "note.md", resolution: "keep-both" },
        { source: "todo.md", resolution: "keep-both" },
      ],
    });
  });

  it("drags the ordered selection to a folder through the same batch controller path", async () => {
    const transfer = dragTransfer();
    renderBrowser({ selectionPlatform: "mac" });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    const todo = screen.getByRole("button", { name: "Open todo.md" });
    const archive = screen.getByRole("button", { name: "Open Archive" });
    fireEvent.click(note);
    fireEvent.click(todo, { metaKey: true });

    fireEvent.dragStart(todo, { dataTransfer: transfer });
    expect(transfer.effectAllowed).toBe("move");
    expect(transfer.setData).toHaveBeenCalledWith(FILE_MOVE_MIME, expect.any(String));
    expect(document.querySelector("[data-file-drag-preview]")?.textContent).toBe("todo.md+1");
    fireEvent.dragOver(archive, { dataTransfer: transfer });
    expect(archive.getAttribute("data-file-drop-target")).toBe("true");
    expect(transfer.dropEffect).toBe("move");
    fireEvent.dragLeave(archive, { dataTransfer: transfer });
    expect(archive.getAttribute("data-file-drop-target")).toBe("false");
    fireEvent.dragOver(archive, { dataTransfer: transfer });
    fireEvent.drop(archive, { dataTransfer: transfer });

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[0]![1]).toMatchObject({
      phase: "preflight",
      sources: ["note.md", "todo.md"],
      destinationDirectory: "Archive",
    });
    expect(document.querySelector("[data-file-drag-preview]")).toBeNull();
  });

  it("accepts Chromium protected-mode dragover before strict payload parsing on drop", async () => {
    const transfer = dragTransfer();
    renderBrowser();
    const note = await screen.findByRole("button", { name: "Open note.md" });
    const archive = screen.getByRole("button", { name: "Open Archive" });
    fireEvent.click(note);
    fireEvent.dragStart(note, { dataTransfer: transfer });
    const serialized = vi.mocked(transfer.setData).mock.calls[0]![1];
    vi.mocked(transfer.getData).mockReturnValue("");

    fireEvent.dragOver(archive, { dataTransfer: transfer });
    expect(archive.getAttribute("data-file-drop-target")).toBe("true");
    expect(transfer.dropEffect).toBe("move");

    fireEvent.dragOver(archive, { dataTransfer: dragTransfer(["text/plain"]) });
    expect(archive.getAttribute("data-file-drop-target")).toBe("false");
    fireEvent.dragOver(archive, { dataTransfer: transfer });
    expect(archive.getAttribute("data-file-drop-target")).toBe("true");

    vi.mocked(transfer.getData).mockReturnValue(serialized);
    fireEvent.drop(archive, { dataTransfer: transfer });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  });

  it("accepts an ancestor breadcrumb drop but never highlights the current directory", async () => {
    const transfer = dragTransfer();
    renderBrowser();
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open Archive" }));
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open Nested" }));
    const deep = await screen.findByRole("button", { name: "Open deep.md" });
    fireEvent.click(deep);
    fireEvent.dragStart(deep, { dataTransfer: transfer });

    const current = screen.getByRole("button", { name: "Nested" });
    fireEvent.dragOver(current, { dataTransfer: transfer });
    expect(current.getAttribute("data-file-drop-target")).toBe("false");
    expect(api.post).not.toHaveBeenCalled();

    const ancestor = screen.getByRole("button", { name: "Archive" });
    fireEvent.dragOver(ancestor, { dataTransfer: transfer });
    expect(ancestor.getAttribute("data-file-drop-target")).toBe("true");
    fireEvent.drop(ancestor, { dataTransfer: transfer });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[0]![1]).toMatchObject({
      sources: ["Archive/Nested/deep.md"],
      destinationDirectory: "Archive",
    });
  });

  it("cancels a prepared conflict without execute and disables Move to for any incapable selection", async () => {
    renderBrowser({ selectionPlatform: "mac" });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    const locked = screen.getByRole("button", { name: "Open locked.md" });
    fireEvent.click(note);
    fireEvent.click(locked, { metaKey: true });
    expect(note.getAttribute("draggable")).toBe("false");
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for locked.md" }), { button: 0 });
    expect((await screen.findByRole("menuitem", { name: "Move to…" })).hasAttribute("data-disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(note);
    api.setConflicts(["note.md"]);
    await startArchiveMove("note.md");
    expect(await screen.findByRole("heading", { name: "Resolve move conflicts" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel move" }));
    expect(api.post).toHaveBeenCalledOnce();
  });

  it("retains skipped rows and focused preview after a partial authoritative move", async () => {
    api.setResultCodes({ "todo.md": "skipped" });
    const onPreviewPathChange = vi.fn();
    renderBrowser({ selectionPlatform: "mac", onPreviewPathChange });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    const todo = screen.getByRole("button", { name: "Open todo.md" });
    fireEvent.click(note);
    fireEvent.click(todo, { metaKey: true });
    await startArchiveMove("todo.md");

    await waitFor(() => expect(screen.queryByRole("button", { name: "Open note.md" })).toBeNull());
    expect(screen.getByRole("button", { name: "Open todo.md" }).getAttribute("aria-pressed")).toBe("true");
    expect(onPreviewPathChange).toHaveBeenLastCalledWith("todo.md");
    expect(screen.getByRole("status").textContent).toMatch(/skipped/i);
    expect(api.get.mock.calls.some(([path]) => path === "/api/files/list?path=Archive")).toBe(true);
  });

  it("keeps an uncertain move selected and never retries until a fresh user action", async () => {
    api.setExecuteError(new AppError("timeout", { cause: new Error("provider /home/operator") }));
    renderBrowser();
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    await startArchiveMove("note.md");

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Open note.md" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toMatch(/could not be confirmed/i);
    expect(screen.getByRole("status").textContent).not.toMatch(/provider|\/home/i);
    await Promise.resolve();
    expect(api.post).toHaveBeenCalledTimes(2);

    await startArchiveMove("note.md");
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(4));
  });

  it("rejects external drops and clears a live internal drag on auth scope change", async () => {
    const view = renderBrowser();
    const archive = await screen.findByRole("button", { name: "Open Archive" });
    const external = dragTransfer(["Files"]);
    Object.defineProperty(external, "files", { value: { length: 1 } });
    fireEvent.dragOver(archive, { dataTransfer: external });
    fireEvent.drop(archive, { dataTransfer: external });
    expect(archive.getAttribute("data-file-drop-target")).toBe("false");
    expect(api.post).not.toHaveBeenCalled();

    const note = screen.getByRole("button", { name: "Open note.md" });
    const internal = dragTransfer();
    fireEvent.click(note);
    fireEvent.dragStart(note, { dataTransfer: internal });
    expect(document.querySelector("[data-file-drag-preview]")).not.toBeNull();
    fireEvent.dragEnd(note, { dataTransfer: internal });
    expect(document.querySelector("[data-file-drag-preview]")).toBeNull();
    fireEvent.dragStart(note, { dataTransfer: internal });
    act(() => useConnection.setState({ authGeneration: 2 }));
    await waitFor(() => expect(document.querySelector("[data-file-drag-preview]")).toBeNull());
    fireEvent.drop(archive, { dataTransfer: internal });
    expect(api.post).not.toHaveBeenCalled();
    const refreshed = await screen.findByRole("button", { name: "Open note.md" });
    const finalTransfer = dragTransfer();
    fireEvent.dragStart(refreshed, { dataTransfer: finalTransfer });
    view.unmount();
    expect(document.querySelector("[data-file-drag-preview]")).toBeNull();
  });

  it("suppresses a held preflight after main navigation and API/runtime/auth replacement", async () => {
    const held = deferred<{
      sources: string[];
      destinationDirectory: string;
      conflicts: [];
      invalid: [];
      preflightFingerprint: string;
    }>();
    api.setPreflightPromise(held.promise);
    const onPreviewPathChange = vi.fn();
    renderBrowser({ onPreviewPathChange });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    await startArchiveMove("note.md");
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(screen.getByText("Preparing move…")).not.toBeNull();

    fireEvent.doubleClick(screen.getByRole("button", { name: "Open Archive", hidden: true }));
    expect(screen.queryByText("Preparing move…")).toBeNull();
    expect(await screen.findByRole("button", { name: "Open Nested" })).not.toBeNull();
    const replacement = makeApi();
    act(() => useConnection.setState({ api: replacement as never, runtimeSlot: "preview", authGeneration: 2 }));
    expect(screen.queryByText("Preparing move…")).toBeNull();
    held.resolve({
      sources: ["note.md"], destinationDirectory: "Archive", conflicts: [], invalid: [],
      preflightFingerprint: "old-fingerprint",
    });
    await act(async () => { await held.promise; await Promise.resolve(); });

    expect(api.post).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading", { name: "Resolve move conflicts" })).toBeNull();
    expect((await screen.findByRole("button", { name: "Open note.md" })).getAttribute("aria-selected")).not.toBe("true");
    expect(onPreviewPathChange).toHaveBeenLastCalledWith(null);
  });

  it("suppresses a held execute after main navigation and auth changes", async () => {
    const held = deferred<{
      results: Array<{ source: string; destination: string; code: "moved" }>;
      affectedDirectories: string[];
    }>();
    api.setExecutePromise(held.promise);
    const onPreviewPathChange = vi.fn();
    renderBrowser({ onPreviewPathChange });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    await startArchiveMove("note.md");
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Open note.md", hidden: true }).hasAttribute("disabled")).toBe(true);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Open Archive", hidden: true }));
    expect(screen.queryByText("Preparing move…")).toBeNull();
    expect(await screen.findByRole("button", { name: "Open Nested" })).not.toBeNull();
    act(() => useConnection.setState({ authGeneration: 2 }));
    held.resolve({
      results: [{ source: "note.md", destination: "Archive/note.md", code: "moved" }],
      affectedDirectories: ["", "Archive"],
    });
    await act(async () => { await held.promise; await Promise.resolve(); });
    expect(api.post).toHaveBeenCalledTimes(2);
    expect((await screen.findByRole("button", { name: "Open note.md" })).getAttribute("aria-selected")).not.toBe("true");
    expect(onPreviewPathChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not dismiss an executing move with Escape or an outside pointer", async () => {
    const held = deferred<{
      results: Array<{ source: string; destination: string; code: "moved" }>;
      affectedDirectories: string[];
    }>();
    api.setExecutePromise(held.promise);
    const onPreviewPathChange = vi.fn();
    renderBrowser({ onPreviewPathChange });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    await startArchiveMove("note.md");
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(screen.getByText("Preparing move…")).not.toBeNull();

    api.settleListing("note.md", "Archive");
    held.resolve({
      results: [{ source: "note.md", destination: "Archive/note.md", code: "moved" }],
      affectedDirectories: ["", "Archive"],
    });
    await act(async () => { await held.promise; await Promise.resolve(); });
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Open note.md" })).toBeNull();
    expect(onPreviewPathChange).toHaveBeenLastCalledWith(null);
  });

  it("shows allowlisted invalid reasons in source order and retains those rows", async () => {
    api.setInvalid([
      { source: "note.md", code: "source_missing" },
      { source: "todo.md", code: "protected" },
    ]);
    api.setResultCodes({ "note.md": "source_missing", "todo.md": "protected" });
    const onPreviewPathChange = vi.fn();
    renderBrowser({ selectionPlatform: "mac", onPreviewPathChange });
    fireEvent.click(await screen.findByRole("button", { name: "Open note.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Open todo.md" }), { metaKey: true });
    await startArchiveMove("todo.md");

    expect(await screen.findByRole("heading", { name: "Resolve move conflicts" })).not.toBeNull();
    expect(screen.getAllByTestId("move-invalid-source").map((row) => row.textContent)).toEqual([
      "note.md", "todo.md",
    ]);
    expect(screen.getByText("This item is no longer available.")).not.toBeNull();
    expect(screen.getByText("This item is protected and cannot be moved.")).not.toBeNull();
    expect(screen.queryByText(/^(source_missing|protected|invalid_destination)$/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move selected items" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Open note.md" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Open todo.md" }).getAttribute("aria-pressed")).toBe("true");
    expect(onPreviewPathChange).toHaveBeenLastCalledWith("note.md");
  });
});
