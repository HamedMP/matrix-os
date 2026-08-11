// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ComputerFileBrowser from "@desktop/renderer/src/features/files/ComputerFileBrowser";
import { useBrowserViewPreference } from "@desktop/renderer/src/features/files/browser-view-preference";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import type { FileDirectoryServerMessage } from "@desktop/renderer/src/lib/kernel-socket";
import { AppError } from "@desktop/renderer/src/lib/errors";

const CAPABILITIES = { canRename: true, canMove: true, canTrash: true };

class FakeDirectorySocket {
  records: Array<{ directory: string; active: boolean; handler: (message: FileDirectoryServerMessage) => void }> = [];
  subscribeDirectory = vi.fn((directory: string, handler: (message: FileDirectoryServerMessage) => void) => {
    const record = { directory, active: true, handler };
    this.records.push(record);
    return () => { record.active = false; };
  });
  touchDirectory = vi.fn(() => true);
  emit(message: FileDirectoryServerMessage) {
    for (const record of this.records) if (record.active) record.handler(message);
  }
}

function makeApi() {
  const entries = [
    { name: "Folder", type: "directory", capabilities: CAPABILITIES },
    { name: "note.md", type: "file", capabilities: CAPABILITIES },
    { name: "todo.md", type: "file", capabilities: CAPABILITIES },
  ];
  let trashCodes: Record<string, "trashed" | "protected" | "failed"> = {};
  const api = {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => ({
      path: new URLSearchParams(path.split("?")[1]).get("path") ?? "",
      entries,
    })),
    post: vi.fn(async (path: string, body: { parentDirectory: string; path?: string; name: string; kind: "file" | "directory"; sources?: string[] }) => {
      if (path === "/api/files/batch/trash") {
        const results = body.sources!.map((source) => ({ source, code: trashCodes[source] ?? "trashed" }));
        for (const result of results) {
          if (result.code === "trashed") entries.splice(entries.findIndex((entry) => entry.name === result.source), 1);
        }
        return { results, sourceDirectory: "" };
      }
      if (path === "/api/files/rename") {
        const oldName = body.path!.split("/").pop();
        const entry = entries.find((candidate) => candidate.name === oldName)!;
        entry.name = body.name;
        return {
          ok: true,
          path: body.path!.includes("/") ? `${body.path!.split("/").slice(0, -1).join("/")}/${body.name}` : body.name,
          resultCode: "renamed",
          capabilities: CAPABILITIES,
        };
      }
      entries.push({ name: body.name, type: body.kind, capabilities: CAPABILITIES });
      return {
        ok: true,
        path: body.parentDirectory ? `${body.parentDirectory}/${body.name}` : body.name,
        resultCode: "created",
        capabilities: CAPABILITIES,
      };
    }),
    setTrashCodes(next: typeof trashCodes) { trashCodes = next; },
    setEntries(next: typeof entries) { entries.splice(0, entries.length, ...next); },
  };
  return api;
}

function renderBrowser(props: Record<string, unknown> = {}) {
  return render(
    <Tooltip.Provider>
      <ComputerFileBrowser {...props as never} />
    </Tooltip.Provider>,
  );
}

describe("Files management UI", () => {
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

  it("keeps a renderer-only New File editor open on blur and cancels without a request", async () => {
    renderBrowser();
    await screen.findByRole("button", { name: "Open note.md" });

    fireEvent.click(screen.getByRole("button", { name: "New File" }));
    const input = screen.getByRole("textbox", { name: "New file name" });
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "draft.md" } });
    fireEvent.blur(input);
    expect(screen.getByRole("textbox", { name: "New file name" })).toBe(input);

    fireEvent.click(screen.getByRole("button", { name: "Cancel new file" }));
    expect(screen.queryByRole("textbox", { name: "New file name" })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("submits a New Folder with Enter and replaces the temporary row from an authoritative listing", async () => {
    renderBrowser();
    await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(screen.getByRole("button", { name: "New Folder" }));
    const input = screen.getByRole("textbox", { name: "New folder name" });
    fireEvent.change(input, { target: { value: "Assets" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/files/create",
      expect.objectContaining({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        parentDirectory: "",
        name: "Assets",
        kind: "directory",
      }),
      { timeoutMs: 60_000 },
    ));
    expect(await screen.findByRole("button", { name: "Open Assets" })).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "New folder name" })).toBeNull();
  });

  it("keeps focused preview separate while mac Command and Shift build an ordered selection", async () => {
    const onOpenFile = vi.fn();
    renderBrowser({ selectionPlatform: "mac", onOpenFile });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    const todo = screen.getByRole("button", { name: "Open todo.md" });
    const folder = screen.getByRole("button", { name: "Open Folder" });

    fireEvent.click(note);
    expect(note.getAttribute("aria-pressed")).toBe("true");
    expect(onOpenFile).toHaveBeenLastCalledWith("note.md");

    fireEvent.click(todo, { metaKey: true });
    expect(note.getAttribute("aria-pressed")).toBe("true");
    expect(todo.getAttribute("aria-pressed")).toBe("true");
    expect(onOpenFile).toHaveBeenLastCalledWith("todo.md");

    fireEvent.click(folder, { shiftKey: true });
    expect(folder.getAttribute("aria-pressed")).toBe("true");
    expect(note.getAttribute("aria-pressed")).toBe("true");
    expect(todo.getAttribute("aria-pressed")).toBe("true");
  });

  it("offers context and ellipsis actions, including real editor and single-item rename seams", async () => {
    const onOpenInEditor = vi.fn();
    renderBrowser({ onOpenInEditor });
    const note = await screen.findByRole("button", { name: "Open note.md" });

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Editor" }));
    expect(onOpenInEditor).toHaveBeenCalledWith("note.md");

    fireEvent.contextMenu(note);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename note.md" });
    fireEvent.change(input, { target: { value: "renamed.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rename" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/files/rename",
      expect.objectContaining({ path: "note.md", name: "renamed.md" }),
      { timeoutMs: 60_000 },
    ));
    expect(await screen.findByRole("button", { name: "Open renamed.md" })).not.toBeNull();
  });

  it("confirms one visible-order Trash batch and retains a partial failed selection with a safe notice", async () => {
    api.setTrashCodes({ "todo.md": "protected" });
    renderBrowser({ selectionPlatform: "mac" });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    const todo = screen.getByRole("button", { name: "Open todo.md" });
    fireEvent.click(note);
    fireEvent.click(todo, { metaKey: true });

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for todo.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    expect(screen.getByRole("heading", { name: "Move 2 items to Trash?" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/files/batch/trash",
      expect.objectContaining({ sources: ["note.md", "todo.md"] }),
      { timeoutMs: 60_000 },
    ));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open note.md" })).toBeNull());
    expect(screen.getByRole("button", { name: "Open todo.md" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toMatch(/protected/i);
    expect(screen.getByRole("status").textContent).not.toMatch(/provider|\/home|todo\.md/i);
  });

  it("subscribes the authenticated directory and reloads its authoritative baseline without stale cleanup", async () => {
    const socket = new FakeDirectorySocket();
    const view = renderBrowser({ directorySocket: socket });
    await screen.findByRole("button", { name: "Open note.md" });
    expect(socket.subscribeDirectory).toHaveBeenCalledWith("", expect.any(Function));
    api.get.mockClear();

    socket.emit({ type: "files:subscribed", directory: "", revision: 4 });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/files/list?path="));
    view.unmount();
    expect(socket.records[0]?.active).toBe(false);
  });

  it("disables both a pending row and its ellipsis until the single Trash promise settles", async () => {
    let resolveTrash!: (value: { results: Array<{ source: string; code: "trashed" }>; sourceDirectory: string }) => void;
    const trashPromise = new Promise<{ results: Array<{ source: string; code: "trashed" }>; sourceDirectory: string }>(
      (resolve) => { resolveTrash = resolve; },
    );
    api.post.mockImplementation(async (path: string) => {
      if (path === "/api/files/batch/trash") return trashPromise;
      throw new Error("unexpected mutation");
    });
    renderBrowser();
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());

    expect(screen.getByRole("button", { name: "Open note.md" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "More actions for note.md" }).hasAttribute("disabled")).toBe(true);

    resolveTrash({ results: [{ source: "note.md", code: "trashed" }], sourceDirectory: "" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Open note.md" }).hasAttribute("disabled")).toBe(false));
  });

  it("starts New File and New Folder from the empty-space context menu, including an empty folder", async () => {
    api.setEntries([]);
    renderBrowser();
    await screen.findByText("This folder is empty.");
    fireEvent.contextMenu(screen.getByTestId("files-listing"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New File" }));
    expect(screen.getByRole("textbox", { name: "New file name" })).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New file name" }), { key: "Escape" });

    fireEvent.contextMenu(screen.getByTestId("files-listing"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New Folder" }));
    expect(screen.getByRole("textbox", { name: "New folder name" })).not.toBeNull();
  });

  it("retains visible selection on refresh and clears focused preview when the row disappears", async () => {
    const onPreviewPathChange = vi.fn();
    renderBrowser({ onPreviewPathChange });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    expect(onPreviewPathChange).toHaveBeenLastCalledWith("note.md");

    const initialLoads = api.get.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(initialLoads));
    expect(screen.getByRole("button", { name: "Open note.md" }).getAttribute("aria-pressed")).toBe("true");

    api.setEntries([
      { name: "Folder", type: "directory", capabilities: CAPABILITIES },
      { name: "todo.md", type: "file", capabilities: CAPABILITIES },
    ]);
    const retainedLoads = api.get.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(retainedLoads));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open note.md" })).toBeNull());
    expect(onPreviewPathChange).toHaveBeenLastCalledWith(null);
  });

  it("shows a bounded explanation instead of silently extending Shift selection beyond 100", async () => {
    api.setEntries(Array.from({ length: 101 }, (_, index) => ({
      name: `file-${String(index).padStart(3, "0")}.md`,
      type: "file" as const,
      capabilities: CAPABILITIES,
    })));
    renderBrowser({ selectionPlatform: "linux" });
    const first = await screen.findByRole("button", { name: "Open file-000.md" });
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "Open file-100.md" }), { shiftKey: true });
    expect(screen.getByRole("status").textContent).toMatch(/up to 100/i);
  });

  it("rejects invalid portable names locally and keeps typed conflicts safe and editable", async () => {
    renderBrowser();
    await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(screen.getByRole("button", { name: "New File" }));
    const input = screen.getByRole("textbox", { name: "New file name" });
    fireEvent.change(input, { target: { value: "CON" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("Choose a valid portable name.");
    expect(api.post).not.toHaveBeenCalled();

    api.post.mockRejectedValueOnce(new AppError("server", {
      detail: "destination_conflict",
      cause: new Error("provider failed at /home/operator/secret"),
    }));
    fireEvent.change(input, { target: { value: "safe.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Create file" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("An item with that name already exists."));
    expect(screen.getByRole("alert").textContent).not.toMatch(/provider|\/home|secret/i);
    expect(screen.getByRole("textbox", { name: "New file name" })).not.toBeNull();
  });

  it("uses Windows Control, ignores the wrong modifier, and disables unavailable or multi-item actions", async () => {
    renderBrowser({ selectionPlatform: "windows" });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    const todo = screen.getByRole("button", { name: "Open todo.md" });
    fireEvent.click(note);
    fireEvent.click(todo, { ctrlKey: true });
    expect(note.getAttribute("aria-pressed")).toBe("true");
    expect(todo.getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for todo.md" }), { button: 0 });
    expect((await screen.findByRole("menuitem", { name: "Rename" })).hasAttribute("data-disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(await screen.findByRole("button", { name: "Open Folder" }), { metaKey: true });
    expect(note.getAttribute("aria-pressed")).toBe("false");
    expect(todo.getAttribute("aria-pressed")).toBe("false");

    cleanup();
    api.setEntries([{ name: "locked.md", type: "file", capabilities: { canRename: false, canMove: false, canTrash: false } }]);
    renderBrowser();
    await screen.findByRole("button", { name: "Open locked.md" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for locked.md" }), { button: 0 });
    expect((await screen.findByRole("menuitem", { name: "Rename" })).hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Move to Trash" }).hasAttribute("data-disabled")).toBe(true);
  });

  it("retains an uncertain Trash result without retrying until a fresh user action", async () => {
    api.post.mockRejectedValueOnce(new AppError("timeout", { cause: new Error("/home/operator/provider") }));
    renderBrowser();
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Open note.md" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toMatch(/could not be confirmed/i);
    expect(screen.getByRole("status").textContent).not.toMatch(/provider|\/home|operator/i);
    await Promise.resolve();
    expect(api.post).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  });

  it("clears editor, selection, and pending state when runtime and auth become stale", async () => {
    let resolveTrash!: (value: { results: Array<{ source: string; code: "trashed" }>; sourceDirectory: string }) => void;
    api.post.mockImplementation(async (path: string) => {
      if (path !== "/api/files/batch/trash") throw new Error("unexpected mutation");
      return new Promise((resolve) => { resolveTrash = resolve; });
    });
    renderBrowser();
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(screen.getByRole("button", { name: "New File" }));
    fireEvent.click(note);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());

    act(() => useConnection.setState({ runtimeSlot: "preview", authGeneration: 2 }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "New file name" })).toBeNull());
    expect((await screen.findByRole("button", { name: "Open note.md" })).getAttribute("aria-pressed")).toBe("false");
    resolveTrash({ results: [{ source: "note.md", code: "trashed" }], sourceDirectory: "" });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Open note.md" }).hasAttribute("disabled")).toBe(false);
  });

  it("rejects an old API reload that settles after the runtime and auth scope changes", async () => {
    let resolveOld!: (value: { path: string; entries: Array<{ name: string; type: "file"; capabilities: typeof CAPABILITIES }> }) => void;
    renderBrowser();
    const note = await screen.findByRole("button", { name: "Open note.md" });
    api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    fireEvent.click(note);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());

    const newApi = makeApi();
    newApi.setEntries([{ name: "fresh.md", type: "file", capabilities: CAPABILITIES }]);
    act(() => useConnection.setState({ api: newApi as never, runtimeSlot: "preview", authGeneration: 2 }));
    await screen.findByRole("button", { name: "Open fresh.md" });
    resolveOld({ path: "", entries: [{ name: "stale.md", type: "file", capabilities: CAPABILITIES }] });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("button", { name: "Open stale.md" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open fresh.md" })).not.toBeNull();
  });

  it("guards a pending rename from repeated submit actions", async () => {
    let resolveRename!: (value: unknown) => void;
    api.post.mockImplementation(() => new Promise((resolve) => { resolveRename = resolve; }));
    renderBrowser();
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.contextMenu(note);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename note.md" });
    fireEvent.change(input, { target: { value: "final.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rename" }));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Save rename" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      resolveRename({ ok: true, path: "final.md", resultCode: "renamed", capabilities: CAPABILITIES });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Rename note.md" })).toBeNull());
  });

  it("replaces an uncertain create draft when the authoritative reload proves success", async () => {
    api.post.mockImplementationOnce(async () => {
      api.setEntries([{ name: "recovered.md", type: "file", capabilities: CAPABILITIES }]);
      throw new AppError("timeout");
    });
    renderBrowser();
    await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(screen.getByRole("button", { name: "New File" }));
    const input = screen.getByRole("textbox", { name: "New file name" });
    fireEvent.change(input, { target: { value: "recovered.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "Open recovered.md" })).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "New file name" })).toBeNull();
  });

  it("keeps the internal selection ref aligned after successful Trash reconciliation", async () => {
    api.post.mockResolvedValueOnce({ results: [{ source: "note.md", code: "trashed" }], sourceDirectory: "" });
    renderBrowser({ selectionPlatform: "mac" });
    const note = await screen.findByRole("button", { name: "Open note.md" });
    fireEvent.click(note);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open note.md" }).getAttribute("aria-pressed")).toBe("false"));
    fireEvent.click(screen.getByRole("button", { name: "Open todo.md" }), { metaKey: true });
    expect(screen.getByRole("button", { name: "Open note.md" }).getAttribute("aria-pressed")).toBe("false");
  });
});
