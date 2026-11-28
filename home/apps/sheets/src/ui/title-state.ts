/** What the title bar says about saving. */
import type { SaveState } from "../../../_shared/office-ui";
import type { SessionState } from "../session/types";

/** A few words for the save state. */
export function saveStatusText(state: SessionState): string {
  if (state.source === "local") return state.dirty ? "Not downloaded yet" : state.lastSavedAt !== null ? "Downloaded" : "On this computer";
  if (state.path === null) return state.dirty ? "Not saved yet" : "New workbook";
  switch (state.saveState) {
    case "saving":
      return "Saving";
    case "pending":
      return "Edited";
    case "conflict":
      return "Changed on disk";
    case "error":
      return "Not saved";
    default:
      return state.dirty ? "Edited" : "Saved";
  }
}

/** The title bar's save-state tone. */
export function titleSaveState(state: SessionState): SaveState {
  if (state.saveState === "saving") return "saving";
  if (state.saveState === "conflict" || state.saveState === "error") return "error";
  return state.dirty ? "unsaved" : "saved";
}
