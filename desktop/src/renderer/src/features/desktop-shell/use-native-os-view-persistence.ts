import { useCallback, useEffect, useRef, useState } from "react";
import type { OsViewMode, OsViewStateResponse } from "@matrix-os/contracts";
import type { ApiClient } from "../../lib/api";
import { loadNativeOsViewStateWithLegacyImport, patchNativeOsViewState } from "../../lib/os-view-state-client";
import type { MatrixApp } from "../apps/apps.api";
import {
  desktopSurfaceBounds,
  useDesktopSurfaces,
  type DesktopSurface,
  type DesktopSurfaceBounds,
  type DesktopViewport,
} from "../../stores/desktop-surfaces";
import {
  captureDesktopIconsHydrationRevision,
  useDesktopIcons,
} from "../../stores/desktop-icons";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";
import { useTabs, type Tab } from "../../stores/tabs";
import { nativeOsViewPatch, nativeTabOsViewPath } from "./native-os-view-persistence";

const OS_VIEW_SAVE_DEBOUNCE_MS = 500;
const OS_VIEW_SAVE_RETRY_MS = 2_000;

export function useNativeOsViewPersistence(input: {
  api: ApiClient | null;
  entryKey?: string;
  navigationChangedRef?: { current: boolean };
  tabs: readonly Tab[];
  surfaces: Readonly<Record<string, DesktopSurface>>;
  installedApps: readonly MatrixApp[];
  mode: OsViewMode;
  viewport: DesktopViewport;
  defaultIconLayout: readonly { path: string; x: number; y: number }[];
}) {
  const [surfaceHydration, setSurfaceHydration] = useState<{
    entry: string | ApiClient | null;
    appliedKeys: readonly string[];
  } | null>(null);
  const [durableState, setDurableState] = useState<OsViewStateResponse | null>(null);
  const loadedRef = useRef(false);
  const [loadedEntry, setLoadedEntry] = useState<string | ApiClient | null>(null);
  const entry = input.entryKey ?? input.api;
  const loadingEntryRef = useRef<string | ApiClient | null>(null);
  const initialTabIdsRef = useRef(new Set<string>());
  const preservedTabIdsRef = useRef(new Set<string>());
  const appliedRef = useRef<Record<string, true>>({});
  const canonicalGeometryRef = useRef<Record<OsViewMode, Record<string, DesktopSurfaceBounds>>>({
    desktop: {},
    canvas: {},
  });
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeApiRef = useRef(input.api);
  const installedAppsRef = useRef(input.installedApps);
  activeApiRef.current = input.api;
  installedAppsRef.current = input.installedApps;

  const schedulePersist = useCallback((delayMs = OS_VIEW_SAVE_DEBOUNCE_MS) => {
    const api = input.api;
    if (!api || activeApiRef.current !== api || !loadedRef.current) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      const mode = useNativeDesktopMode.getState().mode;
      const tabsState = useTabs.getState();
      const surfaceState = useDesktopSurfaces.getState();
      const canonicalGeometry = canonicalGeometryRef.current[mode];
      for (const tab of tabsState.tabs) {
        const path = nativeTabOsViewPath(tab, installedAppsRef.current);
        const surface = surfaceState.surfaces[tab.id];
        if (path && surface && !canonicalGeometry[path]) canonicalGeometry[path] = { ...surface.bounds };
      }
      const transform = useNativeDesktopMode.getState();
      void patchNativeOsViewState(api, nativeOsViewPatch({
        tabs: tabsState.tabs,
        surfaces: surfaceState.surfaces,
        installedApps: installedAppsRef.current,
        mode,
        canonicalGeometry,
        ...(mode === "canvas" ? {
          canvasTransform: { panX: transform.panX, panY: transform.panY, zoom: transform.zoom },
        } : {}),
      })).catch((error: unknown) => {
        console.warn("[os-view-state] Electron Desktop persist failed:", error instanceof Error ? error.name : "UnknownError");
        if (activeApiRef.current === api) schedulePersist(OS_VIEW_SAVE_RETRY_MS);
      });
    }, delayMs);
  }, [input.api]);

  const recordCanonicalBounds = useCallback((
    tab: Tab,
    mode: OsViewMode,
    bounds: DesktopSurfaceBounds,
  ) => {
    const path = nativeTabOsViewPath(tab, installedAppsRef.current);
    if (path) canonicalGeometryRef.current[mode][path] = { ...bounds };
  }, []);

  useEffect(() => {
    activeApiRef.current = input.api;
    return () => {
      if (activeApiRef.current === input.api) activeApiRef.current = null;
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [input.api]);

  useEffect(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    // Auth refresh may replace ApiClient without creating a new runtime entry.
    if (entry !== null && loadedEntry === entry) return;
    loadingEntryRef.current = entry;
    initialTabIdsRef.current = new Set(useTabs.getState().tabs.map((tab) => tab.id));
    preservedTabIdsRef.current = new Set(Object.values(useDesktopSurfaces.getState().surfaces)
      .filter((surface) => surface.mode !== "closed").map((surface) => surface.tabId));
    setLoadedEntry(null);
    setDurableState(null);
    loadedRef.current = false;
    appliedRef.current = {};
    canonicalGeometryRef.current = { desktop: {}, canvas: {} };
    if (!input.api) return;
    let cancelled = false;
    const iconHydrationRevision = captureDesktopIconsHydrationRevision();
    void loadNativeOsViewStateWithLegacyImport(input.api).then((state) => {
      if (cancelled || loadingEntryRef.current !== entry || activeApiRef.current !== input.api) return;
      loadedRef.current = true;
      setLoadedEntry(entry);
      if (input.navigationChangedRef?.current) return;
      canonicalGeometryRef.current = {
        desktop: Object.fromEntries(state.document.desktop.windows.map(({ path, ...bounds }) => [path, bounds])),
        canvas: Object.fromEntries(state.document.canvas.windows.map(({ path, ...bounds }) => [path, bounds])),
      };
      useNativeDesktopMode.getState().setCanvasTransform(state.document.canvas.transform);
      useDesktopIcons.getState().hydrate(state.document.desktop.icons, input.defaultIconLayout, iconHydrationRevision);
      setDurableState(state);
    }).catch((error: unknown) => {
      if (!cancelled) {
        loadedRef.current = true;
        setLoadedEntry(entry);
        console.warn("[os-view-state] Electron Desktop load failed:", error instanceof Error ? error.name : "UnknownError");
      }
    });
    return () => { cancelled = true; };
  }, [entry, input.api, input.defaultIconLayout]);

  useEffect(() => {
    if (!durableState || loadedEntry !== entry || input.navigationChangedRef?.current) return;
    const geometry = canonicalGeometryRef.current[input.mode];
    const appsByPath = Object.fromEntries(durableState.document.apps.map((app) => [app.path, app]));
    const nextSurfaces = { ...useDesktopSurfaces.getState().surfaces };
    let changed = false;
    let applied = false;
    for (const tab of input.tabs) {
      const appliedKey = `${input.mode}:${tab.id}`;
      if (appliedRef.current[appliedKey]) continue;
      const path = nativeTabOsViewPath(tab, input.installedApps);
      const surface = nextSurfaces[tab.id];
      if (!path || !surface) continue;
      appliedRef.current[appliedKey] = true;
      applied = true;
      if (preservedTabIdsRef.current.has(tab.id)) {
        canonicalGeometryRef.current[input.mode][path] = { ...surface.bounds };
        continue;
      }
      const canonical = geometry[path];
      const app = appsByPath[path];
      nextSurfaces[tab.id] = {
        ...surface,
        ...(canonical ? {
          bounds: input.mode === "desktop" ? desktopSurfaceBounds(canonical, input.viewport) : canonical,
        } : {}),
        ...(app?.state === "minimized" ? { mode: "minimized" as const }
          : app?.state === "closed" && initialTabIdsRef.current.has(tab.id) ? { mode: "closed" as const }
            : {}),
      };
      changed = true;
    }
    if (changed) useDesktopSurfaces.setState({ surfaces: nextSurfaces });
    if (applied) setSurfaceHydration({ entry, appliedKeys: Object.keys(appliedRef.current) });
  }, [durableState, entry, loadedEntry, input.installedApps, input.mode, input.surfaces, input.tabs, input.viewport]);

  useEffect(() => useNativeDesktopMode.subscribe((state, previous) => {
    if (state.mode === "canvas"
      && (state.panX !== previous.panX || state.panY !== previous.panY || state.zoom !== previous.zoom)) {
      schedulePersist();
    }
  }), [schedulePersist]);

  const surfacesRestored = loadedEntry === entry && input.tabs.every((tab) => {
    const path = nativeTabOsViewPath(tab, input.installedApps);
    return !path || (input.surfaces[tab.id] && (!durableState || (surfaceHydration?.entry === entry && surfaceHydration.appliedKeys.includes(`${input.mode}:${tab.id}`))));
  });
  return {
    durableState: loadedEntry === entry ? durableState : null,
    loadSettled: Boolean(input.api) && loadedEntry === entry,
    surfacesRestored,
    recordCanonicalBounds,
    schedulePersist,
  };
}
