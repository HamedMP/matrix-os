// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ComputerFileBrowser from "@desktop/renderer/src/features/files/ComputerFileBrowser";
import { useBrowserViewPreference } from "@desktop/renderer/src/features/files/browser-view-preference";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { FILE_MOVE_MIME } from "@desktop/renderer/src/features/files/file-drag";
import { AppError } from "@desktop/renderer/src/lib/errors";

const CAPABILITIES = { canRename: true, canMove: true, canTrash: true };

function dragTransfer(types: string[] = []) {
  const values: Record<string, string> = {};
  return {
    effectAllowed: "uninitialized",
    dropEffect: "none",
    files: [] as unknown as FileList,
    get types() { return types.length ? types : Object.keys(values); },
    getData: vi.fn((type: string) => values[type] ?? ""),
    setData: vi.fn((type: string, value: string) => { values[type] = value; }),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function makeApi() {
  const listings: Record<string, Array<{ name: string; type: "file" | "directory"; capabilities: typeof CAPABILITIES }>> = {
    "": [
      { name: "Archive", type: "directory", capabilities: CAPABILITIES },
      { name: "Folder", type: "directory", capabilities: CAPABILITIES },
      { name: "note.md", type: "file", capabilities: CAPABILITIES },
      { name: "todo.md", type: "file", capabilities: CAPABILITIES },
      { name: "locked.md", type: "file", capabilities: { canRename: false, canMove: false, canTrash: false } },
    ],
    Archive: [{ name: "Nested", type: "directory", capabilities: CAPABILITIES }],
    Folder: [{ name: "Child", type: "directory", capabilities: CAPABILITIES }],
    "Archive/Nested": [{ name: "deep.md", type: "file", capabilities: CAPABILITIES }],
  };
  let prepared: { requestId: string; sources: string[]; destinationDirectory: string } | null = null;
  let conflictSources: string[] = [];
  let resultCodes: Record<string, "moved" | "skipped" | "protected" | "failed"> = {};
  let executeError: unknown = null;
  let preflightPromise: Promise<unknown> | null = null;
  let executePromise: Promise<unknown> | null = null;
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      const directory = new URLSearchParams(path.split("?")[1]).get("path") ?? "";
      return { path: directory, entries: listings[directory] ?? [] };
    }),
    post: vi.fn(async (path: string, body: Record<string, unknown>) => {
      if (path !== "/api/files/batch/move") throw new Error("unexpected mutation");
      if (body.phase === "preflight") {
        prepared = body as unknown as typeof prepared;
        if (preflightPromise) return preflightPromise;
        return {
          sources: body.sources,
          destinationDirectory: body.destinationDirectory,
          conflicts: conflictSources.map((source) => ({ source, destination: `Archive/${source}` })),
          invalid: [],
          preflightFingerprint: "move-fingerprint",
        };
      }
      if (!prepared) throw new Error("execute without preflight");
      if (executePromise) return executePromise;
      if (executeError) {
        const error = executeError;
        executeError = null;
        throw error;
      }
      const sources = prepared.sources;
      for (const source of sources) {
        if ((resultCodes[source] ?? "moved") !== "moved") continue;
        const name = source.split("/").pop()!;
        const sourceDirectory = source.split("/").slice(0, -1).join("/");
        listings[sourceDirectory] = listings[sourceDirectory]!.filter((entry) => entry.name !== name);
        listings[prepared.destinationDirectory] ??= [];
        listings[prepared.destinationDirectory]!.push({ name, type: "file", capabilities: CAPABILITIES });
      }
      return {
        results: sources.map((source) => (resultCodes[source] ?? "moved") === "moved" ? {
          source,
          destination: `${prepared!.destinationDirectory}/${source.split("/").pop()!}`,
          code: "moved",
        } : { source, code: resultCodes[source] }),
        affectedDirectories: [...new Set([...sources.map((source) => source.split("/").slice(0, -1).join("/")), prepared.destinationDirectory])],
      };
    }),
    setConflicts(sources: string[]) { conflictSources = sources; },
    setResultCodes(next: typeof resultCodes) { resultCodes = next; },
    setExecuteError(error: unknown) { executeError = error; },
    setPreflightPromise(promise: Promise<unknown>) { preflightPromise = promise; },
    setExecutePromise(promise: Promise<unknown>) { executePromise = promise; },
  };
}

function renderBrowser(props: Record<string, unknown> = {}) {
  return render(<Tooltip.Provider><ComputerFileBrowser directorySocket={null} {...props as never} /></Tooltip.Provider>);
}

describe("Files move UI", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
    useBrowserViewPreference.setState({ view: "list" });
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
  });

  it("opens an accessible directory-only Move to picker and cancels without transport", async () => {
    renderBrowser({ selectionPlatform: "mac" });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));

    expect(screen.getByRole("heading", { name: "Move 1 item" })).not.toBeNull();
    expect(await screen.findByRole("button", { name: "Choose Archive" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open note.md" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New File" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel move" }));
    expect(screen.queryByRole("heading", { name: "Move 1 item" })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
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
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));

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
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Folder" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));

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
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for todo.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

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
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
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
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for todo.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

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
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Open note.md" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toMatch(/could not be confirmed/i);
    expect(screen.getByRole("status").textContent).not.toMatch(/provider|\/home/i);
    await Promise.resolve();
    expect(api.post).toHaveBeenCalledTimes(2);

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
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

  it("closes synchronously and suppresses a held preflight after API/runtime/auth replacement", async () => {
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
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(screen.getByText("Preparing move…")).not.toBeNull();

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
    expect((await screen.findByRole("button", { name: "Open note.md" })).getAttribute("aria-pressed")).toBe("false");
    expect(onPreviewPathChange).toHaveBeenLastCalledWith(null);
  });

  it("keeps pending rows disabled and suppresses a held execute after auth changes", async () => {
    const held = deferred<{
      results: Array<{ source: string; destination: string; code: "moved" }>;
      affectedDirectories: string[];
    }>();
    api.setExecutePromise(held.promise);
    renderBrowser();
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Open note.md", hidden: true }).hasAttribute("disabled")).toBe(true);

    act(() => useConnection.setState({ authGeneration: 2 }));
    held.resolve({
      results: [{ source: "note.md", destination: "Archive/note.md", code: "moved" }],
      affectedDirectories: ["", "Archive"],
    });
    await act(async () => { await held.promise; await Promise.resolve(); });
    expect(api.post).toHaveBeenCalledTimes(2);
    expect((await screen.findByRole("button", { name: "Open note.md" })).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
