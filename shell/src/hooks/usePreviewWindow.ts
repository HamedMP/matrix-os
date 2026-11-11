"use client";

import { create } from "zustand";

export type PreviewFileType =
  | "text"
  | "code"
  | "markdown"
  | "image"
  | "pdf"
  | "audio"
  | "video";

export type PreviewMode = "source" | "preview" | "wysiwyg";

export interface PreviewTab {
  id: string;
  path: string;
  name: string;
  type: PreviewFileType;
  mode?: PreviewMode;
  authority?: string;
}

const EXT_TYPE_MAP: Record<string, PreviewFileType> = {
  ".md": "markdown",
  ".txt": "text",
  ".log": "text",
  ".csv": "text",
  ".json": "code",
  ".yaml": "code",
  ".yml": "code",
  ".toml": "code",
  ".js": "code",
  ".ts": "code",
  ".jsx": "code",
  ".tsx": "code",
  ".py": "code",
  ".html": "code",
  ".css": "code",
  ".sh": "code",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "code",
  ".pdf": "pdf",
  ".mp3": "audio",
  ".wav": "audio",
  ".mp4": "video",
  ".webm": "video",
};

function detectFileType(filename: string): PreviewFileType {
  const ext = filename.includes(".")
    ? `.${filename.split(".").pop()!.toLowerCase()}`
    : "";
  return EXT_TYPE_MAP[ext] ?? "text";
}

function defaultMode(type: PreviewFileType): PreviewMode | undefined {
  if (type === "markdown") return "preview";
  if (type === "text" || type === "code") return "source";
  return undefined;
}

interface PreviewWindowState {
  tabs: PreviewTab[];
  activeTabId: string | null;
  pendingFocusTabId: string | null;
  unsavedTabs: Set<string>;
}

interface PreviewWindowActions {
  openFile(path: string, options?: { authority: string; mode?: PreviewMode; focus?: boolean }): void;
  consumeTabFocus(id: string): void;
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  setMode(id: string, mode: PreviewMode): void;
  markUnsaved(id: string): void;
  markSaved(id: string): void;
  reorderTabs(fromIndex: number, toIndex: number): void;
}

export const usePreviewWindow = create<
  PreviewWindowState & PreviewWindowActions
>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  pendingFocusTabId: null,
  unsavedTabs: new Set(),

  openFile(path: string, options) {
    const { tabs } = get();
    const { authority, mode, focus } = options ?? {};
    const existing = tabs.find((t) => t.path === path && t.authority === authority);
    if (existing) {
      set({
        activeTabId: existing.id,
        pendingFocusTabId: focus ? existing.id : null,
        tabs: mode ? tabs.map(tab => tab.id === existing.id ? { ...tab, mode } : tab) : tabs,
      });
      return;
    }

    const name = path.split("/").pop() ?? path;
    const type = detectFileType(name);
    const id = crypto.randomUUID();
    const tab: PreviewTab = { id, path, name, type, mode: mode ?? defaultMode(type), ...(authority ? { authority } : {}) };

    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: id,
      pendingFocusTabId: focus ? id : null,
    }));
  },

  consumeTabFocus(id: string) {
    if (get().pendingFocusTabId === id) set({ pendingFocusTabId: null });
  },

  closeTab(id: string) {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;

      const newTabs = s.tabs.filter((t) => t.id !== id);
      const newUnsaved = new Set(s.unsavedTabs);
      newUnsaved.delete(id);

      let newActiveId = s.activeTabId;
      if (s.activeTabId === id) {
        if (newTabs.length === 0) {
          newActiveId = null;
        } else if (idx < newTabs.length) {
          newActiveId = newTabs[idx].id;
        } else {
          newActiveId = newTabs[newTabs.length - 1].id;
        }
      }

      return {
        tabs: newTabs,
        activeTabId: newActiveId,
        pendingFocusTabId: s.pendingFocusTabId === id ? null : s.pendingFocusTabId,
        unsavedTabs: newUnsaved,
      };
    });
  },

  setActiveTab(id: string) {
    set({ activeTabId: id, pendingFocusTabId: null });
  },

  setMode(id: string, mode: PreviewMode) {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return s;
      if (
        tab.type !== "text" &&
        tab.type !== "code" &&
        tab.type !== "markdown"
      ) {
        return s;
      }
      return {
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, mode } : t)),
      };
    });
  },

  markUnsaved(id: string) {
    set((s) => {
      const next = new Set(s.unsavedTabs);
      next.add(id);
      return { unsavedTabs: next };
    });
  },

  markSaved(id: string) {
    set((s) => {
      const next = new Set(s.unsavedTabs);
      next.delete(id);
      return { unsavedTabs: next };
    });
  },

  reorderTabs(fromIndex: number, toIndex: number) {
    set((s) => {
      const newTabs = [...s.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, moved);
      return { tabs: newTabs };
    });
  },
}));

export { detectFileType };
