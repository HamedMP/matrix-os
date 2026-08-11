import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import ComputerFileBrowser from "@desktop/renderer/src/features/files/ComputerFileBrowser";
import { useBrowserViewPreference } from "@desktop/renderer/src/features/files/browser-view-preference";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const CAPABILITIES = { canRename: true, canMove: true, canTrash: true };

export function folderListing(path: string, names: string[]) {
  return { path, entries: names.map((name) => ({ name, type: "directory" as const, capabilities: CAPABILITIES })) };
}

export function dragTransfer(types: string[] = []) {
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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

export function makeApi() {
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
  let invalidItems: Array<{ source: string; code: "source_missing" | "protected" | "invalid_destination" }> = [];
  let resultCodes: Record<string, "moved" | "skipped" | "source_missing" | "protected" | "failed"> = {};
  let executeError: unknown = null;
  const listingErrors: Record<string, unknown> = {};
  const listingPromises: Record<string, Array<Promise<unknown>>> = {};
  let preflightPromise: Promise<unknown> | null = null;
  let executePromise: Promise<unknown> | null = null;
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      const directory = new URLSearchParams(path.split("?")[1]).get("path") ?? "";
      if (listingErrors[directory]) throw listingErrors[directory];
      const queued = listingPromises[directory]?.shift();
      if (queued) return queued;
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
          invalid: invalidItems,
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
    setInvalid(items: typeof invalidItems) { invalidItems = items; },
    setResultCodes(next: typeof resultCodes) { resultCodes = next; },
    setExecuteError(error: unknown) { executeError = error; },
    setListingError(directory: string, error: unknown) { listingErrors[directory] = error; },
    queueListing(directory: string, promise: Promise<unknown>) {
      (listingPromises[directory] ??= []).push(promise);
    },
    setPreflightPromise(promise: Promise<unknown>) { preflightPromise = promise; },
    setExecutePromise(promise: Promise<unknown>) { executePromise = promise; },
    settleListing(source: string, destination: string) {
      const name = source.split("/").pop()!;
      const sourceDirectory = source.split("/").slice(0, -1).join("/");
      listings[sourceDirectory] = listings[sourceDirectory]!.filter((entry) => entry.name !== name);
      listings[destination] ??= [];
      listings[destination]!.push({ name, type: "file", capabilities: CAPABILITIES });
    },
  };
}

export function installMoveApi(api: ReturnType<typeof makeApi>) {
  useBrowserViewPreference.setState({ view: "list" });
  useConnection.setState({
    status: "signed-in",
    handle: "operator",
    platformHost: "https://app.matrix-os.com",
    runtimeSlot: "primary",
    authGeneration: 1,
    api: api as never,
  });
}

export function renderBrowser(props: Record<string, unknown> = {}) {
  return render(<Tooltip.Provider><ComputerFileBrowser directorySocket={null} {...props as never} /></Tooltip.Provider>);
}

export async function openMoveFor(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `More actions for ${name}` }), { button: 0 });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
}

export async function startArchiveMove(name: string) {
  await openMoveFor(name);
  fireEvent.click(await screen.findByRole("button", { name: "Choose Archive" }));
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
}
