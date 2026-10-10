"use client";

import { useCallback, useMemo } from "react";
import type { ApiAppEntry } from "@/api/apps";
import { createCatalogAppPathResolver } from "@/lib/app-catalog-launch";
import { useDesktopConfigStore } from "@/stores/desktop-config";

const EMPTY_PINS: string[] = [];

/** Project saved owner references through the current catalog without rewriting hydration. */
export function useCatalogAppShortcuts(apps: readonly ApiAppEntry[]) {
  const savedPins = useDesktopConfigStore(state => state.pinnedApps) ?? EMPTY_PINS;
  const savedOrder = useDesktopConfigStore(state => state.dockOrder);
  const addSavedDesktopIcon = useDesktopConfigStore(state => state.addDesktopIcon);
  const toggleSavedPin = useDesktopConfigStore(state => state.togglePin);
  const resolvePath = useMemo(() => createCatalogAppPathResolver(apps), [apps]);
  const resolveUnique = useCallback((paths: readonly string[]) => paths.map(resolvePath)
    .filter((path, index, resolved) => resolved.indexOf(path) === index), [resolvePath]);
  const pinnedApps = useMemo(() => resolveUnique(savedPins), [savedPins, resolveUnique]);
  const dockOrder = useMemo(() => savedOrder ? {
    ...savedOrder,
    ...(savedOrder.userApps ? { userApps: resolveUnique(savedOrder.userApps) } : {}),
    ...(savedOrder.systemApps ? { systemApps: resolveUnique(savedOrder.systemApps) } : {}),
  } : undefined, [savedOrder, resolveUnique]);
  const togglePin = useCallback((path: string) => {
    const pins = useDesktopConfigStore.getState().pinnedApps ?? EMPTY_PINS;
    const canonicalPath = resolvePath(path);
    const aliases = pins.filter((pin, index) => resolvePath(pin) === canonicalPath && pins.indexOf(pin) === index);
    // Reuse the store's durable toggle flow once per distinct saved reference.
    if (aliases.length) aliases.forEach(alias => toggleSavedPin(alias));
    else toggleSavedPin(canonicalPath);
  }, [resolvePath, toggleSavedPin]);
  const addDesktopIcon = useCallback<typeof addSavedDesktopIcon>((path, bounds) => {
    const canonicalPath = resolvePath(path);
    const placements = useDesktopConfigStore.getState().desktopIcons ?? [];
    if (placements.some(icon => icon.path !== canonicalPath && resolvePath(icon.path) === canonicalPath)) {
      return Promise.resolve("already-present");
    }
    return addSavedDesktopIcon(canonicalPath, bounds);
  }, [resolvePath, addSavedDesktopIcon]);
  return { pinnedApps, dockOrder, togglePin, addDesktopIcon };
}
