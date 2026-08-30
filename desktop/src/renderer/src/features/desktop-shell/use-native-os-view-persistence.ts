import { useCallback, useEffect, useRef, useState } from "react";
import type { OsViewMode, OsViewStateResponse } from "@matrix-os/contracts";
import type { ApiClient } from "../../lib/api";
import { loadNativeOsViewState, patchNativeOsViewState } from "../../lib/os-view-state-client";
import type { MatrixApp } from "../../stores/apps";
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

export function useNativeOsViewPersistence(input: {
  api: ApiClient | null;
  tabs: readonly Tab[];
  surfaces: Readonly<Record<string, DesktopSurface>>;
  installedApps: readonly MatrixApp[];
  mode: OsViewMode;
  viewport: DesktopViewport;
  defaultIconLayout: readonly { path: string; x: number; y: number }[];
}) {
  const [durableState, setDurableState] = useState<OsViewStateResponse | null>(null);
  const loadedRef = useRef(false);
  const appliedRef = useRef<Record<string, true>>({});
  const canonicalGeometryRef = useRef<Record<OsViewMode, Record<string, DesktopSurfaceBounds>>>({
    desktop: {},
    canvas: {},
  });
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const installedAppsRef = useRef(input.installedApps);
  installedAppsRef.current = input.installedApps;

  const schedulePersist = useCallback(() => {
    if (!input.api || !loadedRef.current) return;
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
      void patchNativeOsViewState(input.api!, nativeOsViewPatch({
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
      });
    }, 500);
  }, [input.api]);

  const recordCanonicalBounds = useCallback((
    tab: Tab,
    mode: OsViewMode,
    bounds: DesktopSurfaceBounds,
  ) => {
    const path = nativeTabOsViewPath(tab, installedAppsRef.current);
    if (path) canonicalGeometryRef.current[mode][path] = { ...bounds };
  }, []);

  useEffect(() => () => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
  }, []);

  useEffect(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    setDurableState(null);
    loadedRef.current = false;
    appliedRef.current = {};
    canonicalGeometryRef.current = { desktop: {}, canvas: {} };
    if (!input.api) return;
    let cancelled = false;
    const iconHydrationRevision = captureDesktopIconsHydrationRevision();
    void loadNativeOsViewState(input.api).then((state) => {
      if (cancelled) return;
      loadedRef.current = true;
      canonicalGeometryRef.current = {
        desktop: Object.fromEntries(state.document.desktop.windows.map(({ path, ...bounds }) => [path, bounds])),
        canvas: Object.fromEntries(state.document.canvas.windows.map(({ path, ...bounds }) => [path, bounds])),
      };
      useNativeDesktopMode.getState().setCanvasTransform(state.document.canvas.transform);
      if (state.revision > 1) {
        useDesktopIcons.getState().hydrate(state.document.desktop.icons, input.defaultIconLayout, iconHydrationRevision);
      }
      setDurableState(state);
    }).catch((error: unknown) => {
      if (!cancelled) {
        loadedRef.current = true;
        console.warn("[os-view-state] Electron Desktop load failed:", error instanceof Error ? error.name : "UnknownError");
      }
    });
    return () => { cancelled = true; };
  }, [input.api, input.defaultIconLayout]);

  useEffect(() => {
    if (!durableState) return;
    const geometry = canonicalGeometryRef.current[input.mode];
    const appsByPath = Object.fromEntries(durableState.document.apps.map((app) => [app.path, app]));
    const nextSurfaces = { ...useDesktopSurfaces.getState().surfaces };
    let changed = false;
    for (const tab of input.tabs) {
      const appliedKey = `${input.mode}:${tab.id}`;
      if (appliedRef.current[appliedKey]) continue;
      const path = nativeTabOsViewPath(tab, input.installedApps);
      const surface = nextSurfaces[tab.id];
      if (!path || !surface) continue;
      appliedRef.current[appliedKey] = true;
      const canonical = geometry[path];
      const app = appsByPath[path];
      nextSurfaces[tab.id] = {
        ...surface,
        ...(canonical ? {
          bounds: input.mode === "desktop" ? desktopSurfaceBounds(canonical, input.viewport) : canonical,
        } : {}),
        ...(app?.state === "minimized" ? { mode: "minimized" as const }
          : app?.state === "closed" ? { mode: "closed" as const }
            : {}),
      };
      changed = true;
    }
    if (changed) useDesktopSurfaces.setState({ surfaces: nextSurfaces });
  }, [durableState, input.installedApps, input.mode, input.surfaces, input.tabs, input.viewport]);

  useEffect(() => useNativeDesktopMode.subscribe((state, previous) => {
    if (state.mode === "canvas"
      && (state.panX !== previous.panX || state.panY !== previous.panY || state.zoom !== previous.zoom)) {
      schedulePersist();
    }
  }), [schedulePersist]);

  return { durableState, recordCanonicalBounds, schedulePersist };
}
