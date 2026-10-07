import { create } from "zustand";
import type { ComposerReferenceToken } from "./composer-reference-tokens";

export type ComposerDraft = {
  requestIdentity: number;
  revision: number;
  text: string;
  referenceTokens: ComposerReferenceToken[];
  projectId: string | null;
};
export const MAX_COMPOSER_DRAFTS = 100;
export type ComposerDrafts = Record<string, ComposerDraft>;

// Memory-only retention across Chat/Project workspace unmounts. The hook fences
// every read/write to the current owner/runtime/auth generation; no credentials
// or drafts are written to disk. One identity and at most 100 LRU drafts remain.
export const useRetainedComposerDrafts = create<{
  identity: string | null;
  drafts: ComposerDrafts;
  sequence: number;
  activate: (identity: string) => void;
  update: (identity: string, updater: (drafts: ComposerDrafts, revision: number) => ComposerDrafts) => void;
}>()((set) => ({
  identity: null,
  drafts: {},
  sequence: 0,
  activate: (identity) => set(state => state.identity === identity ? state : { identity, drafts: {}, sequence: 0 }),
  update: (identity, updater) => set(state => {
    const sequence = (state.identity === identity ? state.sequence : 0) + 1;
    const drafts = updater(state.identity === identity ? state.drafts : {}, sequence);
    return state.identity === identity && drafts === state.drafts ? state : { identity, sequence, drafts };
  }),
}));
