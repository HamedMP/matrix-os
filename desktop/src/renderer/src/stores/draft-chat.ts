// Per-project unsent new-chat drafts. The draft pane unmounts whenever a
// thread is selected (the only way to reach the inspector while drafting);
// without this store the composed prompt is destroyed with it. Session-scoped
// like other transient UI state, bounded to MAX_DRAFT_CHAT_ENTRIES with
// least-recently-touched eviction.
import { create } from "zustand";
import type { AgentThreadComposerDraft } from "@matrix-os/contracts";

export const MAX_DRAFT_CHAT_ENTRIES = 50;

interface DraftChatEntry {
  draft: AgentThreadComposerDraft;
  touchedAt: number;
}

interface DraftChatState {
  entries: Record<string, DraftChatEntry>;
  draftFor: (projectId: string) => AgentThreadComposerDraft | null;
  setDraft: (projectId: string, draft: AgentThreadComposerDraft) => void;
  clearDraft: (projectId: string) => void;
}

export function clearDraftChats(): void {
  useDraftChat.setState({ entries: {} });
}

export const useDraftChat = create<DraftChatState>()((set, get) => ({
  entries: {},

  draftFor: (projectId) => get().entries[projectId]?.draft ?? null,

  setDraft: (projectId, draft) => {
    const merged = { ...get().entries, [projectId]: { draft, touchedAt: Date.now() } };
    const keys = Object.keys(merged);
    if (keys.length <= MAX_DRAFT_CHAT_ENTRIES) {
      set({ entries: merged });
      return;
    }
    // Evict the coldest entries first; the just-touched project always survives.
    const coldest = keys
      .filter((key) => key !== projectId)
      .sort((left, right) => (merged[left]?.touchedAt ?? 0) - (merged[right]?.touchedAt ?? 0));
    const capped = { ...merged };
    for (const key of coldest.slice(0, keys.length - MAX_DRAFT_CHAT_ENTRIES)) {
      delete capped[key];
    }
    set({ entries: capped });
  },

  clearDraft: (projectId) => {
    if (!get().entries[projectId]) return;
    const entries = { ...get().entries };
    delete entries[projectId];
    set({ entries });
  },
}));
