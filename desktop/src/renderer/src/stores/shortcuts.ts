// Renderer copy of the keyboard shortcut bindings (specs/653). The main
// process owns them; this store reads a snapshot, follows shortcuts:changed,
// and submits whole override documents through shortcuts:set.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  formatBinding,
  type ShortcutActionId,
  type ShortcutOverrides,
} from "@matrix-os/contracts/keyboard-shortcuts";
import type { ShortcutSnapshot } from "../../../shared/shortcuts-ipc";
import { invoke, onEvent } from "../lib/operator";

export const SHORTCUT_SAVE_ERROR = "Could not save shortcut. Please try again.";

interface ShortcutsState {
  snapshot: ShortcutSnapshot | null;
  error: string | null;
  load(): Promise<void>;
  save(overrides: ShortcutOverrides): Promise<boolean>;
}

export const useShortcuts: UseBoundStore<StoreApi<ShortcutsState>> = create<ShortcutsState>()((set) => {
  let subscribed = false;
  // Bumped by every snapshot that arrives, so a slower read cannot replace a newer one.
  let revision = 0;

  function apply(snapshot: ShortcutSnapshot): void {
    revision += 1;
    set({ snapshot });
  }

  return {
    snapshot: null,
    error: null,
    load: async () => {
      if (!subscribed) {
        subscribed = true;
        onEvent("shortcuts:changed", apply);
      }
      const readRevision = revision;
      try {
        const snapshot = await invoke("shortcuts:get", {});
        if (revision === readRevision) apply(snapshot);
      } catch (error) {
        console.warn("[shortcuts] could not load bindings:", error);
      }
    },
    save: async (overrides) => {
      try {
        apply(await invoke("shortcuts:set", { overrides }));
        set({ error: null });
        return true;
      } catch (error) {
        console.warn("[shortcuts] could not save bindings:", error);
        set({ error: SHORTCUT_SAVE_ERROR });
        return false;
      }
    },
  };
});

/** The action's first binding as display text ("⌘K", "Ctrl+K"); null when unbound or not loaded yet. */
export function shortcutLabel(
  id: ShortcutActionId,
  snapshot: ShortcutSnapshot | null = useShortcuts.getState().snapshot,
): string | null {
  const binding = snapshot?.effective[id]?.[0];
  if (!snapshot || !binding) return null;
  return formatBinding(binding, snapshot.platform).join(snapshot.platform === "mac" ? "" : "+");
}

/** shortcutLabel that re-renders when the bindings change. */
export function useShortcutLabel(id: ShortcutActionId): string | null {
  return useShortcuts((state) => shortcutLabel(id, state.snapshot));
}
