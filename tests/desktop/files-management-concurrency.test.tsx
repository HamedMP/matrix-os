// @vitest-environment jsdom

import React, { startTransition } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ComputerFileBrowser from "@desktop/renderer/src/features/files/ComputerFileBrowser";
import { useBrowserViewPreference } from "@desktop/renderer/src/features/files/browser-view-preference";
import type { FileDirectoryServerMessage } from "@desktop/renderer/src/lib/kernel-socket";
import { AppError } from "@desktop/renderer/src/lib/errors";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const CAPABILITIES = { canRename: true, canMove: true, canTrash: true };
type Listing = { path: string; entries: Array<{ name: string; type: "file"; capabilities: typeof CAPABILITIES }> };

class FakeDirectorySocket {
  private handlers: Array<(message: FileDirectoryServerMessage) => void> = [];
  subscribeDirectory = vi.fn((_directory: string, handler: (message: FileDirectoryServerMessage) => void) => {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((candidate) => candidate !== handler); };
  });
  touchDirectory = vi.fn(() => true);
  emit(message: FileDirectoryServerMessage) {
    for (const handler of this.handlers) handler(message);
  }
}

function listing(name: string): Listing {
  return { path: "", entries: [{ name, type: "file", capabilities: CAPABILITIES }] };
}

describe("Files listing publication ordering", () => {
  beforeEach(() => {
    useBrowserViewPreference.setState({ view: "list" });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not let an older held Refresh overwrite a newer socket reconciliation", async () => {
    let resolveRefresh!: (value: Listing) => void;
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn()
        .mockResolvedValueOnce(listing("initial.md"))
        .mockImplementationOnce(() => new Promise<Listing>((resolve) => { resolveRefresh = resolve; }))
        .mockResolvedValueOnce(listing("socket-new.md")),
      post: vi.fn(),
    };
    const socket = new FakeDirectorySocket();
    useConnection.setState({
      status: "signed-in",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: api as never,
    });
    render(<Tooltip.Provider><ComputerFileBrowser directorySocket={socket} /></Tooltip.Provider>);
    await screen.findByRole("button", { name: "Open initial.md" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    act(() => socket.emit({ type: "files:subscribed", directory: "", revision: 2 }));
    expect(await screen.findByRole("button", { name: "Open socket-new.md" })).not.toBeNull();

    await act(async () => resolveRefresh(listing("refresh-old.md")));
    expect(screen.queryByRole("button", { name: "Open refresh-old.md" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open socket-new.md" })).not.toBeNull();
  });

  it("settles a held Refresh when the newer socket reconciliation fails", async () => {
    let resolveRefresh!: (value: Listing) => void;
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn()
        .mockResolvedValueOnce(listing("initial.md"))
        .mockImplementationOnce(() => new Promise<Listing>((resolve) => { resolveRefresh = resolve; }))
        .mockRejectedValueOnce(new Error("provider failed at /home/operator")),
      post: vi.fn(),
    };
    const socket = new FakeDirectorySocket();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useConnection.setState({
      status: "signed-in",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: api as never,
    });
    render(<Tooltip.Provider><ComputerFileBrowser directorySocket={socket} /></Tooltip.Provider>);
    await screen.findByRole("button", { name: "Open initial.md" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Loading folder…")).not.toBeNull();
    act(() => socket.emit({ type: "files:subscribed", directory: "", revision: 2 }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));

    await act(async () => resolveRefresh(listing("refresh-old.md")));
    expect(screen.queryByText("Loading folder…")).toBeNull();
    expect(screen.getByRole("button", { name: "Open initial.md" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open refresh-old.md" })).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/provider|\/home\/operator/);
  });

  it("forgets an authoritatively successful uncertain rename even if the old path returns later", async () => {
    let current = listing("note.md");
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async () => current),
      post: vi.fn(async (path: string) => {
        if (path !== "/api/files/rename") throw new Error("unexpected mutation");
        current = listing("renamed.md");
        throw new AppError("timeout");
      }),
    };
    useConnection.setState({
      status: "signed-in",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: api as never,
    });
    render(<Tooltip.Provider><ComputerFileBrowser directorySocket={null} /></Tooltip.Provider>);
    const note = await screen.findByRole("button", { name: "Open note.md" });
    const refresh = screen.getByRole("button", { name: "Refresh folder" });
    fireEvent.contextMenu(note);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename note.md" });
    fireEvent.change(input, { target: { value: "renamed.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rename" }));

    expect(await screen.findByRole("button", { name: "Open renamed.md" })).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Rename note.md" })).toBeNull();

    current = {
      path: "",
      entries: [
        { name: "note.md", type: "file", capabilities: CAPABILITIES },
        { name: "renamed.md", type: "file", capabilities: CAPABILITIES },
      ],
    };
    fireEvent.click(refresh);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole("textbox", { name: "Rename note.md" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open note.md" })).not.toBeNull();
  });

  it("does not let a held Refresh overwrite a later Trash reload", async () => {
    let resolveRefresh!: (value: Listing) => void;
    let current = listing("note.md");
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn()
        .mockImplementationOnce(async () => current)
        .mockImplementationOnce(() => new Promise<Listing>((resolve) => { resolveRefresh = resolve; }))
        .mockImplementation(async () => current),
      post: vi.fn(async (path: string, body: { sources: string[] }) => {
        if (path !== "/api/files/batch/trash") throw new Error("unexpected mutation");
        current = listing("after-trash.md");
        return {
          results: body.sources.map((source) => ({ source, code: "trashed" as const })),
          sourceDirectory: "",
        };
      }),
    };
    useConnection.setState({
      status: "signed-in",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: api as never,
    });
    render(<Tooltip.Provider><ComputerFileBrowser directorySocket={null} /></Tooltip.Provider>);
    const note = await screen.findByRole("button", { name: "Open note.md" });
    const refresh = screen.getByRole("button", { name: "Refresh folder" });
    fireEvent.click(note);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for note.md" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Trash" }));

    fireEvent.click(refresh);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect(await screen.findByRole("button", { name: "Open after-trash.md" })).not.toBeNull();

    await act(async () => resolveRefresh(listing("refresh-old.md")));
    expect(screen.queryByRole("button", { name: "Open refresh-old.md" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open after-trash.md" })).not.toBeNull();
  });

  it("rejects interrupted async publication across an API scope transition", async () => {
    let resolveOld!: (value: Listing) => void;
    const oldApi = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn()
        .mockResolvedValueOnce(listing("old-initial.md"))
        .mockImplementationOnce(() => new Promise<Listing>((resolve) => { resolveOld = resolve; })),
      post: vi.fn(),
    };
    const newApi = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async () => listing("new-scope.md")),
      post: vi.fn(),
    };
    useConnection.setState({
      status: "signed-in",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: oldApi as never,
    });
    render(<Tooltip.Provider><ComputerFileBrowser directorySocket={null} /></Tooltip.Provider>);
    await screen.findByRole("button", { name: "Open old-initial.md" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));
    await waitFor(() => expect(oldApi.get).toHaveBeenCalledTimes(2));

    act(() => startTransition(() => {
      useConnection.setState({ api: newApi as never, authGeneration: 2 });
    }));
    expect(await screen.findByRole("button", { name: "Open new-scope.md" })).not.toBeNull();

    await act(async () => resolveOld(listing("interrupted-old.md")));
    expect(screen.queryByRole("button", { name: "Open interrupted-old.md" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open new-scope.md" })).not.toBeNull();
  });
});
