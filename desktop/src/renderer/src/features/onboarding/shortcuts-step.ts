// Getting started's keyboard shortcuts step (specs/653, Electron Desktop only).
// It is done once Settings → Shortcuts has been opened on this computer. The
// bindings are saved per computer, so whether they have been seen is too.
import { create } from "zustand";
import type { ShortcutActionId } from "@matrix-os/contracts/keyboard-shortcuts";

export const SHORTCUTS_STEP_SEEN_KEY = "matrix:getting-started:shortcuts-seen";

/** The shortcuts the step shows, by their current keys. */
export const SHORTCUTS_STEP_ACTIONS: readonly ShortcutActionId[] = ["app.next", "app.launcher"];

export function readShortcutsStepSeen(): boolean {
  try {
    return localStorage.getItem(SHORTCUTS_STEP_SEEN_KEY) === "1";
  } catch (error: unknown) {
    console.warn("[getting-started] unable to read shortcuts step state:", error instanceof Error ? error.name : typeof error);
    return false;
  }
}

export const useShortcutsStep = create<{ seen: boolean }>()(() => ({ seen: readShortcutsStepSeen() }));

/** Marks the step done; the checklist updates at once and remembers it across launches. */
export function markShortcutsStepSeen(): void {
  if (useShortcutsStep.getState().seen) return;
  useShortcutsStep.setState({ seen: true });
  try {
    localStorage.setItem(SHORTCUTS_STEP_SEEN_KEY, "1");
  } catch (error: unknown) {
    console.warn("[getting-started] unable to save shortcuts step state:", error instanceof Error ? error.name : typeof error);
  }
}
