import { FilePathSchema } from "@matrix-os/contracts";
import { create } from "zustand";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";

export const MAX_DESKTOP_EDITOR_TABS = 16;
export const EDITOR_WORKSPACE_TAB_SPEC = {
  kind: "editor" as const,
  title: "Editor",
  slug: "editor",
  closable: false,
};

const MATRIX_HOME_PREFIX = "/home/matrix/home/";

export function normalizeDesktopEditorPath(rawPath: string): string | null {
  let path = rawPath.trim();
  if (!path) return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  path = path.replace(/^file:\/\//i, "");
  path = path.replace(/:\d+(?::\d+)?$/, "");
  if (path.startsWith(MATRIX_HOME_PREFIX)) path = path.slice(MATRIX_HOME_PREFIX.length);
  else if (path.startsWith("~/")) path = path.slice(2);
  else if (path.startsWith("./")) path = path.slice(2);
  else if (path.startsWith("/")) return null;
  path = path.replace(/\\/g, "/");
  const parsed = FilePathSchema.safeParse(path);
  return parsed.success ? parsed.data : null;
}

interface DesktopEditorState {
  scope: string | null;
  paths: string[];
  activePath: string | null;
  dirtyPaths: string[];
  error: string | null;
  ensureScope(scope: string): void;
  openFile(path: string): boolean;
  setActive(path: string): void;
  setDirty(path: string, dirty: boolean): void;
  closeFile(path: string): void;
  clearError(): void;
}

export const useDesktopEditor = create<DesktopEditorState>()((set, get) => ({
  scope: null,
  paths: [],
  activePath: null,
  dirtyPaths: [],
  error: null,

  ensureScope: (scope) => set((state) => state.scope === scope ? state : {
    scope,
    paths: [],
    activePath: null,
    dirtyPaths: [],
    error: null,
  }),

  openFile: (rawPath) => {
    const path = normalizeDesktopEditorPath(rawPath);
    if (!path) {
      set({ error: "That file path is outside Matrix home." });
      return false;
    }
    const state = get();
    if (state.paths.includes(path)) {
      set({ activePath: path, error: null });
      return true;
    }
    let paths = state.paths;
    let dirtyPaths = state.dirtyPaths;
    if (paths.length >= MAX_DESKTOP_EDITOR_TABS) {
      const victim = paths.find((candidate) => (
        candidate !== state.activePath && !dirtyPaths.includes(candidate)
      )) ?? paths.find((candidate) => !dirtyPaths.includes(candidate));
      if (!victim) {
        set({ error: "Close an unsaved file before opening another editor tab." });
        return false;
      }
      paths = paths.filter((candidate) => candidate !== victim);
      dirtyPaths = dirtyPaths.filter((candidate) => candidate !== victim);
    }
    set({ paths: [...paths, path], activePath: path, dirtyPaths, error: null });
    return true;
  },

  setActive: (path) => {
    if (get().paths.includes(path)) set({ activePath: path });
  },

  setDirty: (path, dirty) => set((state) => ({
    dirtyPaths: dirty
      ? state.dirtyPaths.includes(path)
        ? state.dirtyPaths
        : [...state.dirtyPaths, path].slice(-MAX_DESKTOP_EDITOR_TABS)
      : state.dirtyPaths.filter((candidate) => candidate !== path),
  })),

  closeFile: (path) => set((state) => {
    const index = state.paths.indexOf(path);
    const paths = state.paths.filter((candidate) => candidate !== path);
    const activePath = state.activePath === path
      ? paths[Math.max(0, index - 1)] ?? paths.at(-1) ?? null
      : state.activePath;
    return {
      paths,
      activePath,
      dirtyPaths: state.dirtyPaths.filter((candidate) => candidate !== path),
      error: null,
    };
  }),

  clearError: () => set({ error: null }),
}));

export function currentDesktopEditorScope(): string {
  const { runtimeSlot, authGeneration } = useConnection.getState();
  return `${runtimeSlot}|${authGeneration}`;
}

export function openFileInDesktopEditor(rawPath: string): boolean {
  const editor = useDesktopEditor.getState();
  editor.ensureScope(currentDesktopEditorScope());
  if (!useDesktopEditor.getState().openFile(rawPath)) return false;
  useTabs.getState().openTab(EDITOR_WORKSPACE_TAB_SPEC);
  return true;
}
