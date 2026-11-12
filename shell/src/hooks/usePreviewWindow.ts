"use client";

import { create } from "zustand";
import { fileBlobUrl } from "@/lib/file-blob";

export const MAX_DIRTY_PREVIEW_EDITORS = 3;

export function previewFileRequestSignal(controller: AbortController): AbortSignal {
  return AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
}

interface PreviewDraft {
  tabId: string;
  url: string;
  content: string;
  status: "editing" | "saving" | "failed";
}

// One controller per dirty editor. The draft limit bounds both collections.
const pendingSaves = new Map<string, AbortController>();

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
  authority: string;
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
  draftAuthority: string | null;
  drafts: PreviewDraft[];
  lastSavedTabId: string | null;
}

interface PreviewWindowActions {
  openFile(path: string, options: { authority: string; mode?: PreviewMode; focus?: boolean }): void;
  consumeTabFocus(id: string): void;
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  setMode(id: string, mode: PreviewMode): void;
  markUnsaved(id: string): void;
  markSaved(id: string): void;
  setDraftAuthority(authority: string | null): void;
  changeDraft(id: string, authority: string, url: string, content: string): boolean;
  saveDraft(id: string, authority: string): Promise<void>;
  reorderTabs(fromIndex: number, toIndex: number): void;
}

export const usePreviewWindow = create<
  PreviewWindowState & PreviewWindowActions
>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  pendingFocusTabId: null,
  unsavedTabs: new Set(),
  draftAuthority: null,
  drafts: [],
  lastSavedTabId: null,

  openFile(path, { authority, mode, focus }) {
    const { tabs } = get();
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
    const tab: PreviewTab = { id, path, name, type, mode: mode ?? defaultMode(type), authority };

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
    pendingSaves.get(id)?.abort();
    pendingSaves.delete(id);
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
        drafts: s.drafts.filter(draft => draft.tabId !== id),
        lastSavedTabId: s.lastSavedTabId === id ? null : s.lastSavedTabId,
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

  setDraftAuthority(authority) {
    if (get().draftAuthority === authority) return;
    for (const controller of pendingSaves.values()) controller.abort();
    pendingSaves.clear();
    set({ draftAuthority: authority, drafts: [], unsavedTabs: new Set(), lastSavedTabId: null });
  },

  changeDraft(id, authority, url, content) {
    const state = get();
    const tab = state.tabs.find(tab => tab.id === id);
    const existing = state.drafts.find(draft => draft.tabId === id);
    if (!tab || state.draftAuthority !== authority || tab.authority !== authority
      || (existing ? existing.url !== url : state.drafts.length >= MAX_DIRTY_PREVIEW_EDITORS)) return false;
    const draft: PreviewDraft = { tabId: id, url, content, status: existing?.status === "saving" ? "saving" : "editing" };
    set({
      drafts: existing ? state.drafts.map(item => item.tabId === id ? draft : item) : [...state.drafts, draft],
      unsavedTabs: new Set([...state.unsavedTabs, id]),
      lastSavedTabId: state.lastSavedTabId === id ? null : state.lastSavedTabId,
    });
    return true;
  },

  async saveDraft(id, authority) {
    const state = get();
    const tab = state.tabs.find(tab => tab.id === id);
    const draft = state.drafts.find(draft => draft.tabId === id);
    if (!tab || !draft || state.draftAuthority !== authority || tab.authority !== authority
      || pendingSaves.has(id)) return;
    const updateStatus = (status: PreviewDraft["status"]) => set(s => ({
      drafts: s.drafts.map(item => item.tabId === id ? { ...item, status } : item),
    }));
    if (fileBlobUrl(tab.path) !== draft.url) {
      updateStatus("failed");
      return;
    }

    const controller = new AbortController();
    pendingSaves.set(id, controller);
    updateStatus("saving");
    let saved = false;
    try {
      const response = await fetch(`${draft.url}&force=true`, {
        method: "PUT",
        redirect: "error",
        signal: previewFileRequestSignal(controller),
        body: draft.content,
      });
      saved = response.ok;
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        console.warn("[preview] File could not be saved:", error instanceof Error ? error.name : "unknown");
      }
    }
    if (pendingSaves.get(id) !== controller) return;
    pendingSaves.delete(id);
    const current = get();
    if (current.draftAuthority !== authority) return;
    const latest = current.drafts.find(item => item.tabId === id);
    if (!latest) return;
    if (saved && latest.content === draft.content) {
      const unsavedTabs = new Set(current.unsavedTabs);
      unsavedTabs.delete(id);
      set({ drafts: current.drafts.filter(item => item.tabId !== id), unsavedTabs, lastSavedTabId: id });
    } else {
      updateStatus(saved ? "editing" : "failed");
    }
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
