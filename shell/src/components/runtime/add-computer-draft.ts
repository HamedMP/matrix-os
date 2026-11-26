/** Session-storage key of the in-progress add-computer flow (name, slot, plan), kept across checkout. */
export const ADD_COMPUTER_DRAFT_KEY = "matrix:add-computer-draft:v2";

/** Whether an add-computer flow is saved in this tab (for example a checkout return in progress). */
export function hasSavedAddComputerDraft(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(ADD_COMPUTER_DRAFT_KEY) !== null;
  } catch (error: unknown) {
    console.warn("[add-computer] unable to read the saved flow", error instanceof Error ? error.name : typeof error);
    return false;
  }
}
