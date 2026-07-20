import { useEffect, useEffectEvent, type RefObject } from "react";
import type { AppEntry } from "@/hooks/useWindowManager";
import { iconUrlForSlug } from "@/lib/app-launch";

/**
 * Non-component helpers for the Windows-design shell chrome (kept out of the
 * component modules so those only export components).
 */

export interface TaskbarAppEntry {
  name: string;
  path: string;
  iconUrl?: string;
}

/** Built-ins pinned to the Windows start menus / quick-launch by default. */
const BUILT_IN_START_APPS: readonly (Omit<TaskbarAppEntry, "iconUrl"> & { iconSlug: string })[] = [
  { name: "Terminal", path: "__terminal__", iconSlug: "terminal" },
  { name: "Files", path: "__file-browser__", iconSlug: "files" },
  { name: "Chat", path: "__chat__", iconSlug: "chat" },
];

/** Window paths may carry an instance suffix (`__terminal__:setup`, app
    multi-windows) — the app identity is the base path before `:`. */
export function baseWindowPath(path: string): string {
  return path.split(":")[0];
}

/** Built-in shortcuts prefer the (possibly versioned) icon URL the app
    registry resolved, falling back to the shipped `/icons/*.png` assets. */
export function resolveBuiltInStartApps(apps: AppEntry[]): TaskbarAppEntry[] {
  return BUILT_IN_START_APPS.map(({ iconSlug, ...builtIn }) => ({
    ...builtIn,
    iconUrl: apps.find((a) => a.path === builtIn.path)?.iconUrl ?? iconUrlForSlug(iconSlug),
  }));
}

/** Close a start menu on outside pointer down or Escape (same pattern as the
    MenuBar dropdowns: listeners only while open, close via useEffectEvent). */
export function useStartMenuDismiss(
  open: boolean,
  onClose: () => void,
  taskbarRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
) {
  const onCloseEvent = useEffectEvent(onClose);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (taskbarRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onCloseEvent();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseEvent();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, taskbarRef, menuRef]);
}
