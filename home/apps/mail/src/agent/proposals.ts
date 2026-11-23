/**
 * Agent drafts waiting for the owner's review.
 *
 * An agent draft is saved at the provider and opened in the composer, and is
 * recorded here as a proposal with the text before (`original`) and the
 * agent's text (`proposed`). The composer reads `forDraft(localId)` to show
 * the change as a redline with Keep and Discard; the agent panel lists the
 * same proposals. Nothing here sends.
 */
import { MAX_PANEL_RESULTS } from "./limits";

export type ProposalStatus = "proposed" | "accepted" | "rejected";

export interface DraftProposal {
  id: string;
  /** The composer draft (`DraftState.localId`). */
  draftLocalId: string;
  kind: "reply" | "new";
  accountId: string;
  threadKey: string | null;
  subject: string;
  to: string[];
  /** The owner's text before the agent wrote; empty for a fresh draft. */
  original: string;
  /** The agent's text, now in the draft. */
  proposed: string;
  instruction: string;
  status: ProposalStatus;
  /** True when the draft could not be stored at the provider yet; the composer keeps retrying autosave. */
  saveFailed: boolean;
  createdAt: number;
}

export interface ProposalRegistry {
  subscribe(listener: () => void): () => void;
  /** Newest first. Same array until something changes. */
  list(): readonly DraftProposal[];
  get(id: string): DraftProposal | undefined;
  /** The open proposal for a composer draft, if any. */
  forDraft(draftLocalId: string): DraftProposal | undefined;
  add(proposal: DraftProposal): void;
  update(id: string, patch: Partial<Pick<DraftProposal, "status" | "saveFailed">>): void;
}

const MAX_LISTENERS = 50;

export function createProposalRegistry(): ProposalRegistry {
  let items: readonly DraftProposal[] = [];
  const listeners: Array<() => void> = [];
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener) {
      if (listeners.length >= MAX_LISTENERS) throw new RangeError("Too many proposal listeners");
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    list: () => items,
    get: (id) => items.find((item) => item.id === id),
    forDraft: (draftLocalId) => items.find((item) => item.draftLocalId === draftLocalId && item.status === "proposed"),
    add(proposal) {
      items = [proposal, ...items.filter((item) => item.id !== proposal.id)].slice(0, MAX_PANEL_RESULTS);
      emit();
    },
    update(id, patch) {
      if (!items.some((item) => item.id === id)) return;
      items = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
      emit();
    },
  };
}
