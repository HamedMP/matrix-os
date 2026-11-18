"use client";

import { create } from "zustand";
import { FileLeafNameSchema } from "@matrix-os/contracts";
import { getGatewayUrl } from "@/lib/gateway";
import { usePreviewWindow } from "./usePreviewWindow";

const GATEWAY_URL = getGatewayUrl();

let navSeq = 0;
let searchSeq = 0;
let movingToTrash = false;

export function watchFileBrowserAuthority(gatewayUrl: string) {
  const { draftAuthority } = usePreviewWindow.getState();
  const controller = new AbortController();
  const unsubscribe = usePreviewWindow.subscribe(state => {
    if (state.draftAuthority !== draftAuthority) controller.abort();
  });
  return {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted && getGatewayUrl() === gatewayUrl,
    unsubscribe,
  };
}

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
  created?: string;
  mime?: string;
  children?: number;
  gitStatus?: string | null;
}

export interface SearchMatch {
  line?: number;
  text: string;
  type: "name" | "content";
}

export interface SearchResult {
  path: string;
  name: string;
  type: "file" | "directory";
  matches: SearchMatch[];
}

interface FileBrowserFolderRequest {
  path: string;
  identity: string;
}

interface FileBrowserState {
  currentPath: string;
  history: string[];
  historyIndex: number;
  viewMode: "icon" | "list" | "column";
  sortBy: "name" | "size" | "modified" | "type";
  sortDirection: "asc" | "desc";
  showPreviewPanel: boolean;
  sidebarCollapsed: boolean;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  selectedPaths: Set<string>;
  lastSelectedPath: string | null;
  favorites: string[];
  quickLookPath: string | null;
  searchQuery: string;
  searchResults: SearchResult[] | null;
  searching: boolean;
  clipboard: { paths: string[]; operation: "copy" | "cut" } | null;
  /**
   * One-shot view request from outside the Files window (e.g. the XP desktop
   * icons): the next mounted/active FileBrowser consumes it, shows the
   * requested view and clears the request via `consumeViewRequest`.
   */
  pendingView: "files" | "trash" | null;
  pendingFolder: FileBrowserFolderRequest | null;
}

interface ItemCreationTarget {
  parentPath: string;
  gatewayUrl: string;
  signal: AbortSignal;
}

type ItemCreationResult = { ok: true; path: string } | { ok: false; error: string };

interface FileBrowserActions {
  navigate(path: string): void;
  goBack(): void;
  goForward(): void;
  refresh(options?: { includeSearch?: boolean }): void;
  setViewMode(mode: "icon" | "list" | "column"): void;
  setSortBy(sort: "name" | "size" | "modified" | "type"): void;
  setSortDirection(dir: "asc" | "desc"): void;
  togglePreviewPanel(): void;
  toggleSidebar(): void;
  select(path: string, multi?: boolean, range?: boolean): void;
  selectAll(): void;
  clearSelection(): void;
  setQuickLookPath(path: string | null): void;
  search(query: string): void;
  clearSearch(): void;
  copy(paths: string[]): void;
  cut(paths: string[]): void;
  paste(): Promise<void>;
  rename(from: string, to: string): Promise<{ ok: boolean; error?: string }>;
  deleteFiles(paths: string[]): Promise<void>;
  duplicate(paths: string[]): Promise<void>;
  createFolder(name: string, target?: ItemCreationTarget): Promise<ItemCreationResult>;
  createFile(name: string, target?: ItemCreationTarget): Promise<ItemCreationResult>;
  toggleFavorite(path: string): void;
  requestView(view: "files" | "trash", folder?: FileBrowserFolderRequest): void;
  consumeViewRequest(expectedView?: "files" | "trash", expectedFolder?: FileBrowserFolderRequest | null): boolean;
}

async function fetchEntries(
  path: string,
  gatewayUrl = getGatewayUrl(),
  signal = AbortSignal.timeout(10_000),
): Promise<FileEntry[] | undefined> {
  try {
    const res = await fetch(`${gatewayUrl}/api/files/list?path=${encodeURIComponent(path)}`, {
      signal, cache: "no-store",
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    const entries = data.entries ?? data;
    return Array.isArray(entries) ? entries : undefined;
  } catch (err: unknown) {
    if (!signal.aborted) console.warn("[file-browser] Failed to fetch entries:", err instanceof Error ? err.name : "UnknownError");
    return undefined;
  }
}

function sortEntries(
  entries: FileEntry[],
  sortBy: "name" | "size" | "modified" | "type",
  sortDirection: "asc" | "desc",
): FileEntry[] {
  const dirs = entries.filter((e) => e.type === "directory");
  const files = entries.filter((e) => e.type === "file");

  const compare = (a: FileEntry, b: FileEntry): number => {
    let result = 0;
    switch (sortBy) {
      case "name":
        result = a.name.localeCompare(b.name);
        break;
      case "size":
        result = (a.size ?? 0) - (b.size ?? 0);
        break;
      case "modified":
        result =
          new Date(a.modified ?? 0).getTime() -
          new Date(b.modified ?? 0).getTime();
        break;
      case "type": {
        const extA = a.name.includes(".") ? a.name.split(".").pop()! : "";
        const extB = b.name.includes(".") ? b.name.split(".").pop()! : "";
        result = extA.localeCompare(extB);
        break;
      }
    }
    return sortDirection === "desc" ? -result : result;
  };

  return [...dirs.sort(compare), ...files.sort(compare)];
}

async function createItem(
  kind: "file" | "folder",
  name: string,
  target: ItemCreationTarget | undefined,
  get: () => Pick<FileBrowserState, "currentPath"> & Pick<FileBrowserActions, "refresh">,
  set: (state: Pick<FileBrowserState, "error">) => void,
): Promise<ItemCreationResult> {
  const parentPath = target?.parentPath ?? get().currentPath;
  const gatewayUrl = target?.gatewayUrl ?? getGatewayUrl();
  const current = () => !target?.signal.aborted && gatewayUrl === getGatewayUrl() && get().currentPath === parentPath;
  const fail = (error: string) => {
    if (!target && current()) set({ error });
    return { ok: false, error } as const;
  };
  const parsed = FileLeafNameSchema.safeParse(name);
  if (!parsed.success) return fail(`Enter a ${kind} name without slashes.`);
  const folderChanged = `The current folder changed. Reopen New ${kind} and try again.`;
  if (!current()) return fail(folderChanged);

  const path = parentPath ? `${parentPath}/${parsed.data}` : parsed.data;
  const endpoint = kind === "folder" ? "mkdir" : "touch";
  const timeout = AbortSignal.timeout(10_000);
  try {
    const response = await fetch(`${gatewayUrl}/api/files/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
      redirect: "error",
      signal: target ? AbortSignal.any([target.signal, timeout]) : timeout,
    });
    if (!current()) return fail(folderChanged);
    if (!response.ok) {
      return fail(response.status === 409 && kind === "file"
        ? "The file name or folder is unavailable. Check the name and try again."
        : `Failed to create ${kind}`);
    }
    get().refresh();
    return { ok: true, path };
  } catch (error: unknown) {
    if (current()) console.warn(`[file-browser] Could not create ${kind}:`, error instanceof Error ? error.name : "Unknown error");
    return fail(`Failed to create ${kind}`);
  }
}

export const useFileBrowser = create<FileBrowserState & FileBrowserActions>()(
  (set, get) => ({
    currentPath: "",
    history: [""],
    historyIndex: 0,
    viewMode: "icon",
    sortBy: "name",
    sortDirection: "asc",
    showPreviewPanel: false,
    sidebarCollapsed: false,
    entries: [],
    loading: false,
    error: null,
    selectedPaths: new Set(),
    lastSelectedPath: null,
    favorites: [],
    quickLookPath: null,
    searchQuery: "",
    searchResults: null,
    searching: false,
    clipboard: null,
    pendingView: null,
    pendingFolder: null,

    navigate(path: string) {
      const { history, historyIndex } = get();
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(path);
      set({
        currentPath: path,
        history: newHistory,
        historyIndex: newHistory.length - 1,
        selectedPaths: new Set(),
        lastSelectedPath: null,
        searchQuery: "",
        searchResults: null,
        searching: false,
        loading: true,
        error: null,
      });
      const seq = ++navSeq;
      fetchEntries(path).then((entries) => {
        if (seq !== navSeq) return;
        const { sortBy, sortDirection } = get();
        set({ entries: sortEntries(entries ?? [], sortBy, sortDirection), loading: false });
      });
    },

    goBack() {
      const { history, historyIndex } = get();
      if (historyIndex <= 0) return;
      const newIndex = historyIndex - 1;
      const path = history[newIndex];
      set({
        currentPath: path,
        historyIndex: newIndex,
        selectedPaths: new Set(),
        lastSelectedPath: null,
        loading: true,
      });
      const seq = ++navSeq;
      fetchEntries(path).then((entries) => {
        if (seq !== navSeq) return;
        const { sortBy, sortDirection } = get();
        set({ entries: sortEntries(entries ?? [], sortBy, sortDirection), loading: false });
      });
    },

    goForward() {
      const { history, historyIndex } = get();
      if (historyIndex >= history.length - 1) return;
      const newIndex = historyIndex + 1;
      const path = history[newIndex];
      set({
        currentPath: path,
        historyIndex: newIndex,
        selectedPaths: new Set(),
        lastSelectedPath: null,
        loading: true,
      });
      const seq = ++navSeq;
      fetchEntries(path).then((entries) => {
        if (seq !== navSeq) return;
        const { sortBy, sortDirection } = get();
        set({ entries: sortEntries(entries ?? [], sortBy, sortDirection), loading: false });
      });
    },

    refresh({ includeSearch = false } = {}) {
      const { currentPath } = get();
      const gatewayUrl = getGatewayUrl();
      const authority = watchFileBrowserAuthority(gatewayUrl);
      const signal = AbortSignal.any([authority.signal, AbortSignal.timeout(10_000)]);
      set({ loading: true });
      const seq = ++navSeq;
      void fetchEntries(currentPath, gatewayUrl, signal).then((entries) => {
        if (seq !== navSeq || !authority.isCurrent()) return;
        const { sortBy, sortDirection, error } = get();
        if (!entries) {
          set({ error: error ?? "Could not refresh Files. Try again.", loading: false });
          return;
        }
        set({ entries: sortEntries(entries, sortBy, sortDirection), loading: false });
      }).finally(authority.unsubscribe);
      const { searchQuery } = get();
      if (includeSearch && searchQuery.trim()) get().search(searchQuery);
    },

    setViewMode(mode) {
      set({ viewMode: mode });
    },

    setSortBy(sort) {
      const { entries, sortDirection } = get();
      set({ sortBy: sort, entries: sortEntries(entries, sort, sortDirection) });
    },

    setSortDirection(dir) {
      const { entries, sortBy } = get();
      set({ sortDirection: dir, entries: sortEntries(entries, sortBy, dir) });
    },

    togglePreviewPanel() {
      set((s) => ({ showPreviewPanel: !s.showPreviewPanel }));
    },

    toggleSidebar() {
      set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
    },

    select(path, multi = false, _range = false) {
      set((s) => {
        if (multi) {
          const next = new Set(s.selectedPaths);
          if (next.has(path)) {
            next.delete(path);
          } else {
            next.add(path);
          }
          return { selectedPaths: next, lastSelectedPath: path };
        }
        return { selectedPaths: new Set([path]), lastSelectedPath: path };
      });
    },

    selectAll() {
      set((s) => ({
        selectedPaths: new Set(s.entries.map((e) => e.name)),
      }));
    },

    clearSelection() {
      set({ selectedPaths: new Set(), lastSelectedPath: null });
    },

    setQuickLookPath(path) {
      set({ quickLookPath: path });
    },

    search(query) {
      if (!query.trim()) {
        get().clearSearch();
        return;
      }
      const gatewayUrl = getGatewayUrl();
      const authority = watchFileBrowserAuthority(gatewayUrl);
      const signal = AbortSignal.any([authority.signal, AbortSignal.timeout(10_000)]);
      const seq = ++searchSeq;
      const isCurrent = () => seq === searchSeq && get().searchQuery === query && authority.isCurrent();
      set({ searchQuery: query, searching: true });
      void fetch(`${gatewayUrl}/api/files/search?q=${encodeURIComponent(query)}&content=true`, {
        signal, cache: "no-store",
      })
        .then(async (res) => {
          if (!res.ok) throw new Error("Files search unavailable");
          const data = await res.json() as { results?: SearchResult[] } | null;
          if (!Array.isArray(data?.results)) throw new Error("Invalid Files search response");
          if (isCurrent()) set({ searchResults: data.results, searching: false });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          console.warn("[file-browser] Failed to search files:", error instanceof Error ? error.name : "UnknownError");
          set({ searchResults: [], searching: false });
        })
        .finally(authority.unsubscribe);
    },

    clearSearch() {
      searchSeq++;
      set({ searchQuery: "", searchResults: null, searching: false });
    },

    copy(paths) {
      set({ clipboard: { paths, operation: "copy" } });
    },

    cut(paths) {
      set({ clipboard: { paths, operation: "cut" } });
    },

    async paste() {
      const { clipboard, currentPath } = get();
      if (!clipboard) return;

      const endpoint = clipboard.operation === "copy" ? "copy" : "rename";
      const results = await Promise.all(
        clipboard.paths.map(async (sourcePath) => {
          const name = sourcePath.split("/").pop() ?? sourcePath;
          const destPath = currentPath ? `${currentPath}/${name}` : name;

          const res = await fetch(`${GATEWAY_URL}/api/files/${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: sourcePath, to: destPath }),
            signal: AbortSignal.timeout(10_000),
          });
          return { sourcePath, ok: res.ok };
        }),
      );
      const failed = results.reduce<string[]>((acc, r) => {
        if (!r.ok) acc.push(r.sourcePath);
        return acc;
      }, []);

      if (clipboard.operation === "cut") {
        if (failed.length === 0) {
          set({ clipboard: null });
        } else {
          set({ clipboard: { paths: failed, operation: "cut" } });
        }
      }
      get().refresh();
    },

    async rename(from, to) {
      const res = await fetch(`${GATEWAY_URL}/api/files/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await res.json();
      if (result.ok) get().refresh();
      return result;
    },

    async deleteFiles(paths) {
      if (paths.length === 0 || movingToTrash) return;
      const label = paths.length === 1 ? `“${paths[0].split("/").at(-1)}”` : `${paths.length} items`;
      const gatewayUrl = getGatewayUrl();
      const currentPath = get().currentPath;
      const moved: string[] = [];
      const authority = watchFileBrowserAuthority(gatewayUrl);
      movingToTrash = true;
      try {
        if (!window.confirm(`Move ${label} to Trash? You can restore them from Trash.`) || !authority.isCurrent()) return;
        set({ error: null });
        for (const path of paths) {
          if (!authority.isCurrent()) return;
          try {
            const res = await fetch(`${gatewayUrl}/api/files/delete`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path }),
              signal: AbortSignal.any([authority.signal, AbortSignal.timeout(10_000)]),
            });
            if (res.ok) moved.push(path);
          } catch (error) {
            if (!authority.isCurrent()) return;
            console.warn("[file-browser] Move to Trash unavailable:", error instanceof Error ? error.name : "UnknownError");
          }
        }
        if (!authority.isCurrent()) return;
        if (get().currentPath === currentPath) {
          const remaining = new Set(get().selectedPaths);
          for (const path of moved) {
            const name = path.split("/").at(-1);
            if (name && path === (currentPath ? `${currentPath}/${name}` : name)) remaining.delete(name);
          }
          set({
            selectedPaths: remaining,
            error: moved.length === paths.length ? null : "Move to Trash could not be confirmed for every item. Check Files or Trash.",
          });
        }
        get().refresh({ includeSearch: moved.length > 0 });
      } finally {
        authority.unsubscribe();
        movingToTrash = false;
      }
    },

    async duplicate(paths) {
      const errors = await Promise.all(
        paths.map(async (path) => {
          const res = await fetch(`${GATEWAY_URL}/api/files/duplicate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) {
            return `Failed to duplicate ${path.split("/").pop()}`;
          }
          return null;
        }),
      );
      const firstError = errors.find((error): error is string => error !== null);
      if (firstError) set({ error: firstError });
      get().refresh();
    },

    createFolder(name, target) {
      return createItem("folder", name, target, get, set);
    },

    createFile(name, target) {
      return createItem("file", name, target, get, set);
    },

    toggleFavorite(path) {
      set((s) => {
        const next = s.favorites.includes(path)
          ? s.favorites.filter((f) => f !== path)
          : [...s.favorites, path];
        return { favorites: next };
      });
    },

    requestView(view, folder) {
      set({ pendingView: view, pendingFolder: view === "files" ? folder ?? null : null });
    },

    consumeViewRequest(expectedView, expectedFolder) {
      const { pendingView, pendingFolder } = get();
      if (expectedView && (pendingView !== expectedView || pendingFolder !== expectedFolder)) return false;
      set({ pendingView: null, pendingFolder: null });
      return true;
    },
  }),
);
