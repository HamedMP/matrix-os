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
