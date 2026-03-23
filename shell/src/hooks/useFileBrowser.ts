"use client";

import { create } from "zustand";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

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
}

interface FileBrowserActions {
  navigate(path: string): void;
  goBack(): void;
  goForward(): void;
  refresh(): void;
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
  createFolder(name: string): Promise<void>;
  createFile(name: string): Promise<void>;
  toggleFavorite(path: string): void;
}

async function fetchEntries(path: string): Promise<FileEntry[]> {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/files/list?path=${encodeURIComponent(path)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.entries ?? data;
  } catch {
    return [];
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
        loading: true,
        error: null,
      });
      fetchEntries(path).then((entries) => {
        const { sortBy, sortDirection } = get();
        set({ entries: sortEntries(entries, sortBy, sortDirection), loading: false });
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
      fetchEntries(path).then((entries) => {
        const { sortBy, sortDirection } = get();
        set({ entries: sortEntries(entries, sortBy, sortDirection), loading: false });
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
      fetchEntries(path).then((entries) => {
        const { sortBy, sortDirection } = get();
        set({ entries: sortEntries(entries, sortBy, sortDirection), loading: false });
      });
    },

    refresh() {
      const { currentPath } = get();
      set({ loading: true });
      fetchEntries(currentPath).then((entries) => set({ entries, loading: false }));
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
        set({ searchQuery: "", searchResults: null, searching: false });
        return;
      }
      set({ searchQuery: query, searching: true });
      fetch(
        `${GATEWAY_URL}/api/files/search?q=${encodeURIComponent(query)}&content=true`,
      )
        .then((res) => res.json())
        .then((data: { results: SearchResult[] }) =>
          set({ searchResults: data.results, searching: false }),
        )
        .catch(() => set({ searchResults: [], searching: false }));
    },

    clearSearch() {
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

      for (const sourcePath of clipboard.paths) {
        // clipboard stores full relative paths already
        const name = sourcePath.split("/").pop() ?? sourcePath;
        const destPath = currentPath ? `${currentPath}/${name}` : name;

        if (clipboard.operation === "copy") {
          await fetch(`${GATEWAY_URL}/api/files/copy`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: sourcePath, to: destPath }),
          });
        } else {
          await fetch(`${GATEWAY_URL}/api/files/rename`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: sourcePath, to: destPath }),
          });
        }
      }

      if (clipboard.operation === "cut") {
        set({ clipboard: null });
      }
      get().refresh();
    },

    async rename(from, to) {
      const res = await fetch(`${GATEWAY_URL}/api/files/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const result = await res.json();
      if (result.ok) get().refresh();
      return result;
    },

    async deleteFiles(paths) {
      for (const path of paths) {
        await fetch(`${GATEWAY_URL}/api/files/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
      }
      set({ selectedPaths: new Set() });
      get().refresh();
    },

    async duplicate(paths) {
      for (const path of paths) {
        await fetch(`${GATEWAY_URL}/api/files/duplicate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
      }
      get().refresh();
    },

    async createFolder(name) {
      const { currentPath } = get();
      const path = currentPath ? `${currentPath}/${name}` : name;
      await fetch(`${GATEWAY_URL}/api/files/mkdir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      get().refresh();
    },

    async createFile(name) {
      const { currentPath } = get();
      const path = currentPath ? `${currentPath}/${name}` : name;
      await fetch(`${GATEWAY_URL}/api/files/touch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      get().refresh();
    },

    toggleFavorite(path) {
      set((s) => {
        const next = s.favorites.includes(path)
          ? s.favorites.filter((f) => f !== path)
          : [...s.favorites, path];
        return { favorites: next };
      });
    },
  }),
);
