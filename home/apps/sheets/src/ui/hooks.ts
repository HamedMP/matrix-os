/** Hooks that follow the session host, a session and the grid selection. */
import { useCallback, useSyncExternalStore } from "react";
import type { GridSelection, SheetGridController } from "../grid";
import type { HostState, SessionHost, SessionState } from "../session";
import type { SheetSession } from "../session/session";

export function useHostState(host: SessionHost): HostState {
  const subscribe = useCallback((listener: () => void) => host.subscribe(listener), [host]);
  const read = useCallback(() => host.getState(), [host]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The session's state snapshot; `revision` grows with every content change. */
export function useSessionState(session: SheetSession): SessionState {
  const subscribe = useCallback((listener: () => void) => session.subscribe(() => listener()), [session]);
  const read = useCallback(() => session.getState(), [session]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Whether the active sheet's view has a filter. A filter changes the view only, so neither the session nor the selection reports it. */
export function useGridFiltered(controller: SheetGridController): boolean {
  const subscribe = useCallback((listener: () => void) => controller.context.store.subscribe(listener), [controller]);
  const read = useCallback(() => controller.isFiltered, [controller]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The grid selection; a new object whenever the selection or the active sheet changes. */
export function useGridSelection(controller: SheetGridController): GridSelection {
  const subscribe = useCallback((listener: () => void) => mirrorOf(controller).subscribe(listener), [controller]);
  const read = useCallback(() => mirrorOf(controller).value, [controller]);
  return useSyncExternalStore(subscribe, read, read);
}

interface SelectionMirror {
  value: GridSelection;
  subscribe(listener: () => void): () => void;
}

const mirrors = new WeakMap<SheetGridController, SelectionMirror>();
const MAX_MIRROR_LISTENERS = 32;

/** One selection listener per controller, shared by every component that reads the selection. */
function mirrorOf(controller: SheetGridController): SelectionMirror {
  const known = mirrors.get(controller);
  if (known !== undefined) return known;
  const listeners = new Set<() => void>();
  const mirror: SelectionMirror = {
    value: controller.getSelection(),
    subscribe(listener) {
      if (listeners.size >= MAX_MIRROR_LISTENERS) throw new Error("too many selection listeners");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  controller.onSelectionChange((selection) => {
    mirror.value = selection;
    for (const listener of [...listeners]) listener();
  });
  mirrors.set(controller, mirror);
  return mirror;
}
