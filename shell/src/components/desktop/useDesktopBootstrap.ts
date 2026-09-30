"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowManager, type LayoutWindow, type AppWindow } from "@/hooks/useWindowManager";
import { useDesktopMode } from "@/stores/desktop-mode";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { getGatewayUrl } from "@/lib/gateway";
import { isPreVpsBillingSetupRoute } from "@/lib/pre-vps-shell";
import { loadWebOsViewPresentation } from "@/lib/os-view-state-client";
import { loadShellSnapshot, saveShellSnapshot, type ShellSnapshotScope } from "@/lib/shell-snapshot-cache";
import { isRestorableBuiltInAppPath, normalizeBuiltInAppPath, normalizeBuiltInLayoutWindow } from "@/lib/builtin-apps";
import { gatewayFetchSignal, registryPathToRelativePath, type ModuleMeta, type ShellBootstrap } from "./desktop-app-routing";

/** Restore owner layout once; subsequent module refreshes cannot undo live navigation. */
export function useDesktopBootstrap({ cacheScope, entryKey, openWindow }: {
  cacheScope?: ShellSnapshotScope | null;
  entryKey: string;
  openWindow: (name: string, path: string) => void;
}) {
  const gatewayUrl = getGatewayUrl();
  const [settledEntry, setSettledEntry] = useState<string | null>(null);
  const currentEntryRef = useRef(entryKey);
  const completedRef = useRef(false);
  const restoringRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const navigationChangedRef = useRef(false);
  // Borrow the immutable owner snapshot instead of accumulating a duplicate path cache.
  // Release after this entry settles; a refreshed bootstrap never restores again.
  const initialWindowsRef = useRef<readonly AppWindow[] | null>(useWindowManager.getState().windows);
  useEffect(() => {
    if (currentEntryRef.current === entryKey) return;
    currentEntryRef.current = entryKey;
    completedRef.current = false;
    navigationChangedRef.current = false;
    initialWindowsRef.current = useWindowManager.getState().windows;
  }, [entryKey]);
  useEffect(() => {
    if (!completedRef.current && !initialWindowsRef.current) initialWindowsRef.current = useWindowManager.getState().windows;
    return () => { initialWindowsRef.current = null; };
  }, []);
  useEffect(() => useWindowManager.subscribe((state, previous) => {
    if (!restoringRef.current && (state.windows !== previous.windows || state.focusedWindowId !== previous.focusedWindowId)) {
      navigationChangedRef.current = true;
    }
  }), [entryKey]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity consumed by the module-load useEffect dependency array (L~1070); a fresh function each render would re-run the layout/modules/apps fetch on every render
  const loadModules = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    const isLoadAborted = () => signal?.aborted === true
      || currentEntryRef.current !== entryKey || loadGenerationRef.current !== generation;
    const mayRestore = () => !completedRef.current && !navigationChangedRef.current;
    const restoring = (apply: () => void) => {
      restoringRef.current = true;
      try { apply(); } finally { restoringRef.current = false; }
    };
    const fetchForLoad = async (input: RequestInfo | URL): Promise<Response | null> => {
      if (isLoadAborted()) return null;
      const response = await fetch(input, {
        signal: gatewayFetchSignal(signal),
      });
      return isLoadAborted() ? null : response;
    };
    const readJsonForLoad = async <T,>(response: Response): Promise<T | null> => {
      if (isLoadAborted()) return null;
      const data = await response.json() as T;
      return isLoadAborted() ? null : data;
    };
    const applyBootstrap = async (
      bootstrap: ShellBootstrap,
      options: { resolveModuleMetadata: boolean },
    ) => {
      if (isLoadAborted()) return;

      const savedLayout: { windows?: LayoutWindow[] } =
        !isPreVpsBillingSetupRoute() ? bootstrap.layout ?? {} : {};
      const rawWindows = savedLayout.windows ?? [];
      // Legacy bootstrap/cache reads do not pass through the canonical OS-view schema.
      // Reject malformed batches at its 512-window limit, never truncate owner layout.
      if (!Array.isArray(rawWindows) || rawWindows.length > 512) throw new Error("Invalid desktop restore batch");
      const savedWindows = rawWindows.map(normalizeBuiltInLayoutWindow);
      const savedLayoutForPath = (path: string) => savedWindows.findLast((window) => window.path === path);

      // Both local arrays are bounded by that validated batch and released after this load.
      const layoutToLoad: LayoutWindow[] = [];
      const queueSavedLayout = (saved: LayoutWindow | undefined) => {
        if (!mayRestore() || !saved || initialWindowsRef.current?.some((window) => window.path === saved.path)
          || layoutToLoad.some((window) => window.path === saved.path)) return;
        layoutToLoad.push(saved);
      };

      const savedBuiltIns = savedWindows.filter((w) => isRestorableBuiltInAppPath(w.path));
      for (const saved of savedBuiltIns) {
        queueSavedLayout(saved);
      }

      // Load pre-installed apps from /api/apps (apps/ directory)
      if (Array.isArray(bootstrap.apps)) {
        for (const app of bootstrap.apps) {
          if (isLoadAborted()) return;
          const relativePath = normalizeBuiltInAppPath(app.path.replace(/^\/files\//, ""));
          const saved = savedLayoutForPath(relativePath);
          queueSavedLayout(saved);
          // Don't auto-open pre-installed apps - let users open from dock/store
        }
      }

      // Load modules from modules.json (Node/Python apps with ports)
      if (Array.isArray(bootstrap.modules)) {
        const registry = bootstrap.modules;

        for (const mod of registry) {
          if (isLoadAborted()) return;
          if (mod.status !== "active") continue;
          if (!options.resolveModuleMetadata) {
            const relativeBasePath = registryPathToRelativePath(mod.path);
            if (!relativeBasePath) continue;
            const defaultEntryFile = mod.type === "react-app" ? "dist/index.html" : "index.html";
            const path = normalizeBuiltInAppPath(`${relativeBasePath}/${defaultEntryFile}`);
            const saved = savedLayoutForPath(path);
            queueSavedLayout(saved);
            continue;
          }

          try {
            const relativeBasePath = registryPathToRelativePath(mod.path);
            if (!relativeBasePath) continue;

            const metaCandidates = relativeBasePath.startsWith("apps/")
              ? [
                  `${gatewayUrl}/files/${relativeBasePath}/matrix.json`,
                  `${gatewayUrl}/files/${relativeBasePath}/module.json`,
                  `${gatewayUrl}/files/${relativeBasePath}/manifest.json`,
                ]
              : [
                  `${gatewayUrl}/files/${relativeBasePath}/manifest.json`,
                  `${gatewayUrl}/files/${relativeBasePath}/module.json`,
                  `${gatewayUrl}/files/${relativeBasePath}/matrix.json`,
                ];

            let metaRes: Response | undefined;
            for (const candidate of metaCandidates) {
              // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential-by-design priority fallback: tries the candidate manifest filenames in order and breaks on the first that exists; parallelizing would always fire every request and lose the priority semantics
              const res = await fetchForLoad(candidate);
              if (!res) return;
              if (res.ok) {
                metaRes = res;
                break;
              }
            }

            const defaultEntryFile =
              mod.type === "react-app" ? "dist/index.html" : "index.html";
            let path = `${relativeBasePath}/${defaultEntryFile}`;
            let appName = mod.name;

            if (!metaRes?.ok) {
              path = normalizeBuiltInAppPath(path);
              const saved = savedLayoutForPath(path);
              queueSavedLayout(saved);
              continue;
            }

            const meta = await readJsonForLoad<ModuleMeta>(metaRes);
            if (!meta) return;
            const entryFile = meta.entry ?? meta.entryPoint ?? "index.html";
            path = normalizeBuiltInAppPath(`${relativeBasePath}/${entryFile}`);
            appName = meta.name ?? mod.name;

            const saved = savedLayoutForPath(path);
            if (saved) {
              queueSavedLayout(saved);
            } else {
              // Preserve post-build module launches; only saved layout hydration is one-shot.
              if (completedRef.current || mayRestore()) restoring(() => openWindow(appName, path));
            }
          } catch (err) {
            if (isLoadAborted()) return;
            console.warn(`[desktop] Failed to load module "${mod.name}":`, err);
          }
        }
      }

      if (isLoadAborted() || !mayRestore()) return;
      if (layoutToLoad.length > 0) {
        restoring(() => {
          const focusedWindowId = useWindowManager.getState().focusedWindowId;
          useWindowManager.getState().loadLayout(layoutToLoad);
          if ((initialWindowsRef.current?.length ?? 0) > 0) useWindowManager.setState({ focusedWindowId });
        });
      }
    };

    try {
      const cachedBootstrap = loadShellSnapshot(cacheScope)?.bootstrap as ShellBootstrap | undefined;
      if (cachedBootstrap) {
        await applyBootstrap(cachedBootstrap, { resolveModuleMetadata: false });
      }

      const bootstrapRes = await fetchForLoad(`${gatewayUrl}/api/shell/bootstrap`).catch((err) => {
        if (isLoadAborted()) return null;
        console.warn("[desktop] Failed to fetch shell bootstrap:", err);
        return undefined;
      });
      if (bootstrapRes === null) return;
      const bootstrap = bootstrapRes?.ok ? await readJsonForLoad<ShellBootstrap>(bootstrapRes) : {};
      if (bootstrap === null) return;
      if (!isPreVpsBillingSetupRoute()) {
        const presentation = await loadWebOsViewPresentation(gatewayUrl, useDesktopMode.getState().mode, signal);
        if (presentation && mayRestore()) {
          bootstrap.layout = { windows: presentation.windows };
          useCanvasTransform.getState().setTransform(
            presentation.transform.zoom,
            presentation.transform.panX,
            presentation.transform.panY,
          );
        }
      }
      if (bootstrapRes?.ok) saveShellSnapshot(cacheScope, { bootstrap });
      await applyBootstrap(bootstrap, { resolveModuleMetadata: true });
    } catch (err) {
      if (isLoadAborted()) return;
      console.warn("[desktop] Failed to load desktop modules:", err);
    } finally {
      if (!isLoadAborted()) {
        completedRef.current = true;
        initialWindowsRef.current = null;
        setSettledEntry(entryKey);
      }
    }
  }, [cacheScope, entryKey, gatewayUrl, openWindow]);


  useEffect(() => {
    const controller = new AbortController();
    void loadModules(controller.signal);
    return () => { controller.abort(); loadGenerationRef.current += 1; };
  }, [loadModules]);

  return { loadModules, settled: settledEntry === entryKey, navigationChangedRef };
}
