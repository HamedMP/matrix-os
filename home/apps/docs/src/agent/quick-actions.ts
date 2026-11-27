/** The panel's quick actions and the request each one makes. */

export type QuickActionId = "tighten" | "proofread" | "summarise" | "review";

export interface QuickAction {
  id: QuickActionId;
  label: string;
  /** `edit`: tracked changes; `answer`: text with citations; `review`: comments against the owner's instructions. */
  kind: "edit" | "answer" | "review";
  /** The instruction sent for an edit action. */
  instruction: string;
}

export const QUICK_ACTIONS: readonly QuickAction[] = Object.freeze([
  {
    id: "tighten",
    label: "Tighten",
    kind: "edit",
    instruction:
      "Tighten the wording: remove redundant words and shorten long sentences without changing the meaning, defined terms, numbers, dates or obligations.",
  },
  {
    id: "proofread",
    label: "Proofread",
    kind: "edit",
    instruction:
      "Proofread: correct spelling, grammar, punctuation and inconsistent capitalisation of defined terms. Do not rephrase text that is already correct.",
  },
  { id: "summarise", label: "Summarise", kind: "answer", instruction: "Summarise this document." },
  {
    id: "review",
    label: "Review against instructions",
    kind: "review",
    instruction: "",
  },
]);

/** The quick actions that leave the document as it is, the only ones offered in the read-only (Original) view. */
export function readingQuickActions(readOnly: boolean): readonly QuickAction[] {
  return readOnly ? QUICK_ACTIONS.filter((action) => action.kind === "answer") : QUICK_ACTIONS;
}

/** Said when an editing request reaches the assistant in the read-only view. */
export const READ_ONLY_MESSAGE = "The Original view is read-only, so nothing was changed. Switch to another view to edit with the assistant.";
