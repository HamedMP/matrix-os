// Persistent file-tree state (roots, lazily-loaded children, expansion) for the
// VPS home. Lives in a store rather than component state so opening a file —
// which can remount the Files panel when the editor panel appears — never
// collapses the tree or drops loaded directories.
import { create } from "zustand";
import type { ApiClient } from "../lib/api";

export interface FileEntry {
  name: string;
  type: "file" | "directory";
}

export function parseEntries(value: unknown): FileEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: FileEntry[] = [];
  for (const raw of value.slice(0, 1000)) {
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as FileEntry).name === "string" &&
      ((raw as FileEntry).type === "file" || (raw as FileEntry).type === "directory")
    ) {
      entries.push({ name: (raw as FileEntry).name, type: (raw as FileEntry).type });
    }
  }
  return entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
  );
}

interface FileTreeState {
  roots: FileEntry[] | null;
  childrenByPath: Record<string, FileEntry[]>;
  expanded: Record<string, boolean>;
  loadingRoots: boolean;
  loadingPaths: Record<string, boolean>;
  loadRoots(api: ApiClient, force?: boolean): Promise<void>;
  toggle(api: ApiClient, path: string): Promise<void>;
}

async function listDir(api: ApiClient, path: string): Promise<FileEntry[]> {
  const res = await api.get<{ entries: unknown }>(`/api/files/list?path=${encodeURIComponent(path)}`);
  return parseEntries(res.entries);
}

export const useFileTree = create<FileTreeState>()((set, get) => ({
  roots: null,
  childrenByPath: {},
  expanded: {},
  loadingRoots: false,
  loadingPaths: {},

  loadRoots: async (api, force = false) => {
    if (get().roots !== null && !force) return;
    if (get().loadingRoots) return;
    set(
      force
        ? { roots: null, childrenByPath: {}, expanded: {}, loadingPaths: {}, loadingRoots: true }
        : { loadingRoots: true },
    );
    try {
      const roots = await listDir(api, "");
      set({ roots, loadingRoots: false });
    } catch (err: unknown) {
      console.warn("[files] root list failed:", err instanceof Error ? err.message : String(err));
      set({ roots: null, loadingRoots: false });
    }
  },

  toggle: async (api, path) => {
    const open = !get().expanded[path];
    set((s) => ({ expanded: { ...s.expanded, [path]: open } }));
    // Lazy-load children once, then keep them cached across collapse/expand.
    if (open && get().childrenByPath[path] === undefined) {
      if (get().loadingPaths[path]) return;
      set((s) => ({ loadingPaths: { ...s.loadingPaths, [path]: true } }));
      try {
        const children = await listDir(api, path);
        set((s) => {
          if (!s.loadingPaths[path]) return s;
          return {
            childrenByPath: { ...s.childrenByPath, [path]: children },
            loadingPaths: { ...s.loadingPaths, [path]: false },
          };
        });
      } catch (err: unknown) {
        console.warn("[files] list failed:", err instanceof Error ? err.message : String(err));
        set((s) => {
          const childrenByPath = { ...s.childrenByPath };
          delete childrenByPath[path];
          return {
            childrenByPath,
            expanded: { ...s.expanded, [path]: false },
            loadingPaths: { ...s.loadingPaths, [path]: false },
          };
        });
      }
    }
  },
}));
