"use client";

import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { useWindowManager, type LayoutWindow } from "@/hooks/useWindowManager";
import { useCommandStore } from "@/stores/commands";
import { useDesktopMode } from "@/stores/desktop-mode";
import { useVocalStore } from "@/stores/vocal";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useDesktopConfigStore } from "@/stores/desktop-config";
import { parseDesktopFirstRunStatus, type DesktopFirstRunStatus } from "@/lib/desktop-first-run";
import { MissionControl } from "./MissionControl";
import { DotGrid } from "./DotGrid";
import { Settings, type SettingsSectionId } from "./Settings";
import { CanvasRenderer } from "./canvas/CanvasRenderer";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SettingsIcon, MessageSquareIcon, LayoutGridIcon } from "@/lib/hugeicons";
import { UserButton } from "./UserButton";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { WindowsTaskbar } from "./taskbar/WindowsTaskbar";
import { XpDesktopIcons } from "./desktop/XpDesktopIcons";
import { useThemeStyle } from "./window/useThemeStyle";
import { OsSessionHost } from "./os-session/OsSessionHost";
import { CanvasToolbar } from "./canvas/CanvasToolbar";
import { VocalPanel } from "./VocalPanel";
import { gatewayAssetUrl, getGatewayUrl } from "@/lib/gateway";
import { isPreVpsBillingSetupRoute } from "@/lib/pre-vps-shell";
import { ChatPopover } from "./ChatPopover";
import { SetupChecklist } from "./onboarding/SetupChecklist";
import { RuntimeIdentityBanner } from "./RuntimeIdentityBanner";
import { ShellNotificationStack } from "./ShellNotificationStack";
import { versionedIconUrl } from "@/lib/icon-url";
import { nameToSlug } from "@/lib/utils";
import { iconUrlForSlug } from "@/lib/app-launch";
import { reconcileDesignApps, type ApiAppEntry } from "@/lib/design-apps-refresh";
import { HERMES_CHAT_HIDDEN, VOICE_HIDDEN, getCodeEditorUrl } from "@/lib/feature-flags";
import {
  buildWebDesktopLauncherApps,
  resolveWebDesktopBuiltInLaunch,
} from "@/lib/web-desktop-app-launch";
import {
  createOsViewLayoutMemory,
  transitionOsViewLayout,
} from "@/lib/os-view-layout-memory";
import { isMainSectionApp, applyOrder } from "@/lib/dock-sections";
import { MatrixLoadingScreen } from "./MatrixLoadingScreen";
import {
  enqueueTerminalLaunch,
  TERMINAL_SETUP_WINDOW_PATH,
  type TerminalLaunchAction,
} from "@/lib/terminal-launch";
import {
  loadShellSnapshot,
  saveShellSnapshot,
  type ShellSnapshotScope,
} from "@/lib/shell-snapshot-cache";
import {
  isBuiltInAppPath,
  isRestorableBuiltInAppPath,
  isRetiredBuiltInAppPath,
  normalizeBuiltInAppPath,
  normalizeBuiltInLayoutWindow,
} from "@/lib/builtin-apps";
import {
  DESKTOP_GATEWAY_FETCH_TIMEOUT_MS as GATEWAY_FETCH_TIMEOUT_MS,
  findAppByName,
  gatewayFetchSignal,
  registryPathToRelativePath,
  sameIconAsset,
  type ModuleMeta,
  type ShellBootstrap,
} from "./desktop/desktop-app-routing";
import { AoedeDockButton, DockIcon } from "./desktop/DesktopDockControls";
import { DesktopWindow, hasActiveWindowInteraction } from "./desktop/DesktopWindow";
import { WebDesktopSurface } from "./desktop/WebDesktopSurface";
import {
  WebDesktopControls,
  type WebDesktopSettingsSection,
} from "./desktop/WebDesktopControls";
import { openShellSupport } from "@/lib/posthog-client";
import { Reorder } from "framer-motion";

const GATEWAY_URL = getGatewayUrl();
// Stable fallback so `pinnedApps` keeps a constant reference when the store
// value is absent — an inline `?? []` would allocate a fresh array each render
// and destabilize every memo/callback that depends on `pinnedApps`. Treated as
// read-only by convention; consumers always build new arrays rather than mutate.
const EMPTY_PINNED_APPS: string[] = [];
const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

interface DesktopProps {
  launchAppPath?: string | null;
  onOpenCommandPalette?: () => void;
  chat?: import("@/hooks/useChatState").ChatState;
  cacheScope?: ShellSnapshotScope | null;
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- no-giant-component: cohesive root shell component; extraction tracked separately. prefer-useReducer: the state values here (interacting, settingsOpen, chatOpen, minimizingIds, firstRunStatus, manualSetupVisible, vocalMounted, plus mode flags) are independent shell concerns, not one related state machine; collapsing them into a reducer would couple unrelated transitions and obscure behavior in the core shell component
export function Desktop({ launchAppPath, onOpenCommandPalette, chat, cacheScope }: DesktopProps) {
  const windows = useWindowManager((s) => s.windows);
  const apps = useWindowManager((s) => s.apps);
  const wmCloseWindow = useWindowManager((s) => s.closeWindow);
  const wmMinimizeWindow = useWindowManager((s) => s.minimizeWindow);
  const wmRestoreAndFocusWindow = useWindowManager((s) => s.restoreAndFocusWindow);
  const wmOpenWindow = useWindowManager((s) => s.openWindow);
  const wmFocusWindow = useWindowManager((s) => s.focusWindow);
  const wmMoveWindow = useWindowManager((s) => s.moveWindow);
  const wmResizeWindow = useWindowManager((s) => s.resizeWindow);
  const wmReconcileWindowsToViewport = useWindowManager((s) => s.reconcileWindowsToViewport);
  const wmGetWindow = useWindowManager((s) => s.getWindow);
  const wmSetApps = useWindowManager((s) => s.setApps);
  const wmSetWindows = useWindowManager((s) => s.setWindows);
  const wmLoadLayout = useWindowManager((s) => s.loadLayout);
  const fullscreenWindowId = useWindowManager((s) => s.fullscreenWindowId);
  const wmToggleFullscreen = useWindowManager((s) => s.toggleFullscreen);
  const wmExitFullscreen = useWindowManager((s) => s.exitFullscreen);

  const [interacting, setInteracting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDefaultSection, setSettingsDefaultSection] = useState<SettingsSectionId>("appearance");
  // Chat popup is now fully controlled here so the dock button can toggle
  // it on click (open if closed, close if open). ChatPopover used to wrap
  // the button in Radix Dialog.Trigger, which only opened — clicking the
  // dock to dismiss never worked, especially obvious while the agent was
  // busy because the popup auto-opens then resists close.
  const [chatOpen, setChatOpen] = useState(false);
  const [minimizingIds, setMinimizingIds] = useState<Set<string>>(new Set());
  const [firstRunStatus, setFirstRunStatus] = useState<DesktopFirstRunStatus>("checking");
  // Shell hydration always uses the shared Matrix brand surface. Theme-specific
  // OS boot screens are reserved for actual OS-session transitions so this
  // account → journey → Desktop handoff cannot visually swap designs.
  const launchPathConsumedRef = useRef<string | null>(null);
  const designApiPathsRef = useRef<Set<string>>(new Set());
  const [manualSetupVisible, setManualSetupVisible] = useState(false);

  const dock = useDesktopConfigStore((s) => s.dock);
  const pinnedApps = useDesktopConfigStore((s) => s.pinnedApps) ?? EMPTY_PINNED_APPS;
  const togglePin = useDesktopConfigStore((s) => s.togglePin);
  const dockOrder = useDesktopConfigStore((s) => s.dockOrder);
  const reorderDockSection = useDesktopConfigStore((s) => s.reorderDockSection);
  const desktopIcons = useDesktopConfigStore((s) => s.desktopIcons);
  const moveDesktopIcon = useDesktopConfigStore((s) => s.moveDesktopIcon);
  const removeDesktopIcon = useDesktopConfigStore((s) => s.removeDesktopIcon);
  const addDesktopIcon = useDesktopConfigStore((s) => s.addDesktopIcon);
  const appLaunchTimes = useWindowManager((s) => s.appLaunchTimes);
  const isHorizontal = dock.position === "bottom";
  const tooltipSide: "left" | "right" | "top" = dock.position === "left" ? "right" : dock.position === "right" ? "left" : "top";
  const dockXOffset = dock.position === "left" ? dock.size + 16 : 20;

  const minimizeTimers = useRef<Map<string, ReturnType<typeof setTimeout>> | null>(null);
  if (minimizeTimers.current === null) minimizeTimers.current = new Map();

  useEffect(() => {
    const timers = minimizeTimers.current!;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- intentional one-shot first-run status load on mount; fully guarded with AbortController, a `cancelled` flag, a timeout, and effect cleanup, so a data-fetching library would add no safety here
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(() => controller.abort(), GATEWAY_FETCH_TIMEOUT_MS);
    void fetch(`${getGatewayUrl()}/api/settings/onboarding-status`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("onboarding status unavailable");
        const nextStatus = parseDesktopFirstRunStatus(await res.json());
        if (!cancelled) {
          setFirstRunStatus(nextStatus);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          console.warn("[desktop] first-run status check failed:", err);
        }
        if (!cancelled) {
          setFirstRunStatus("ready");
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity consumed by the command-registration useEffect dependency array (L~1435); a fresh function each render would re-register every command-palette entry on every render
  const animateMinimize = useCallback((id: string) => {
    if (minimizeTimers.current!.has(id)) return;
    setMinimizingIds((prev) => new Set(prev).add(id));
    const timer = setTimeout(() => {
      wmMinimizeWindow(id);
      minimizeTimers.current!.delete(id);
      setMinimizingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 500);
    minimizeTimers.current!.set(id, timer);
  }, [wmMinimizeWindow]);

  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const resizeRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const viewportReconcilePendingRef = useRef(false);

  useEffect(() => {
    let frame: number | null = null;
    const scheduleReconcile = () => {
      viewportReconcilePendingRef.current = true;
      if (dragRef.current || resizeRef.current) return;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        viewportReconcilePendingRef.current = false;
        wmReconcileWindowsToViewport();
      });
    };

    window.addEventListener("resize", scheduleReconcile);
    if (!interacting && viewportReconcilePendingRef.current) scheduleReconcile();
    return () => {
      window.removeEventListener("resize", scheduleReconcile);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [interacting, wmReconcileWindowsToViewport]);

  const generatingRef = useRef<Set<string> | null>(null);
  if (generatingRef.current === null) generatingRef.current = new Set<string>();

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity feeds app-tile regenerate handlers and avoids re-registering commands that close over app actions
  const regenerateIcon = useCallback((slug: string) => {
    generatingRef.current!.add(slug);
    fetch(`${GATEWAY_URL}/api/apps/${slug}/icon`, {
      method: "POST",
      signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
    })
      .then((r) => {
        if (!r.ok) {
          r.json()
            .then((d: { error?: string }) => console.warn(`Icon regen failed for "${slug}":`, d.error))
            .catch((err) => console.warn(`[desktop] Failed to parse icon regeneration error for "${slug}":`, err));
          return;
        }
        return r.json().then((data: { iconUrl: string; etag?: string }) => {
          wmSetApps((prev) =>
            prev.map((a) =>
              nameToSlug(a.name) === slug
                ? { ...a, iconUrl: versionedIconUrl(`${GATEWAY_URL}${data.iconUrl}`, data.etag) }
                : a,
            ),
          );
        });
      })
      .catch((err) => console.warn(`Icon regen request failed for "${slug}":`, err))
      .finally(() => generatingRef.current!.delete(slug));
  }, [wmSetApps]);

  const renameAppOnServer = (slug: string, newName: string) => {
    fetch(`${GATEWAY_URL}/api/apps/${slug}/rename`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
      signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
    })
      .then((r) => {
        if (!r.ok) {
          r.json()
            .then((d: { error?: string }) => console.warn(`Rename failed for "${slug}":`, d.error))
            .catch((err) => console.warn(`[desktop] Failed to parse rename error for "${slug}":`, err));
          return;
        }
        return r.json().then((data: { newSlug?: string }) => {
          if (data.newSlug) {
            const oldSlug = slug;
            const ns = data.newSlug;
            wmSetApps((prev) =>
              prev.map((a) => {
                const aSlug = nameToSlug(a.name);
                if (aSlug === oldSlug) {
                  const newPath = a.path.includes("/")
                    ? `apps/${ns}/index.html`
                    : `apps/${ns}.html`;
                  return {
                    ...a,
                    name: newName,
                    path: newPath,
                    iconUrl: iconUrlForSlug(ns),
                  };
                }
                return a;
              }),
            );
            // Update open windows
            wmSetWindows((prev) =>
              prev.map((w) => {
                const wSlug = w.path.replace("apps/", "").replace(/\/index\.html$/, "").replace(/\.html$/, "");
                if (wSlug === oldSlug) {
                  const newPath = w.path.includes("/")
                    ? `apps/${ns}/index.html`
                    : `apps/${ns}.html`;
                  return { ...w, title: newName, path: newPath };
                }
                return w;
              }),
            );
          }
        });
      })
      .catch((err) => console.warn(`Rename request failed for "${slug}":`, err));
  };

  const removeFromCanvas = (appPath: string) => {
    wmSetWindows((prev) => prev.filter((w) => w.path !== appPath && !w.path.startsWith(appPath + ":")));
  };

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity feeds loadModules' deps, and loadModules is a useEffect dependency (L~1070); a fresh function each render would re-fire the module-load effect every render
  const addApp = useCallback((name: string, path: string, iconSlug?: string, iconUrlOverride?: string) => {
    if (isRetiredBuiltInAppPath(path)) return;
    const iconUrl = iconUrlOverride ?? iconUrlForSlug(iconSlug);
    wmSetApps((prev) => {
      const existing = prev.find((a) => a.path === path);
      if (existing) {
        const nextIconUrl = iconUrl === undefined
          ? existing.iconUrl
          : sameIconAsset(existing.iconUrl, iconUrl) ? existing.iconUrl : iconUrl;
        if (existing.name === name && existing.iconUrl === nextIconUrl) return prev;
        return prev.map((app) => app.path === path ? { ...app, name, iconUrl: nextIconUrl } : app);
      }
      return [...prev, { name, path, iconUrl }];
    });
  }, [wmSetApps]);


  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity consumed by the command-registration useEffect dependency array (L~1435) and feeds loadModules' deps (also a useEffect dependency); a fresh function each render would re-fire both effects every render
  const openWindow = useCallback((name: string, path: string) => {
    if (isRetiredBuiltInAppPath(path)) return;
    // Open without minimizing other windows — allow multiple apps visible.
    // Terminal is a singleton app now; individual shell sessions live inside
    // its Paper drawer rather than separate OS windows.
    wmOpenWindow(name, path, dockXOffset);

    // In canvas mode, pan to center on the window after it opens/focuses
    if (useDesktopMode.getState().mode === "canvas") {
      requestAnimationFrame(() => {
        const win = useWindowManager.getState().windows.find((w) => w.path === path);
        if (win) {
          const cRect = useCanvasTransform.getState().containerRect;
          useCanvasTransform.getState().focusOnWindow(
            win,
            cRect?.width ?? window.innerWidth,
            cRect?.height ?? window.innerHeight,
          );
        }
      });
    }
  }, [wmOpenWindow, dockXOffset]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity feeds focusOrOpen's deps, and focusOrOpen is a useEffect dependency (L~930); a fresh function each render would re-fire the launch-path effect every render
  const focusCanvasWindow = useCallback((winId: string) => {
    if (useDesktopMode.getState().mode !== "canvas") return;
    requestAnimationFrame(() => {
      const win = useWindowManager.getState().getWindow(winId);
      if (!win || win.minimized) return;
      const cRect = useCanvasTransform.getState().containerRect;
      useCanvasTransform.getState().focusOnWindow(
        win,
        cRect?.width ?? window.innerWidth,
        cRect?.height ?? window.innerHeight,
      );
    });
  }, []);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity consumed by the launch-path useEffect dependency array (L~930); a fresh function each render would re-fire that effect every render
  const focusOrOpen = useCallback((name: string, path: string) => {
    const existing = useWindowManager.getState().windows.find(
      (w) => w.path === path || w.path.startsWith(path + ":"),
    );

    if (existing) {
      wmRestoreAndFocusWindow(existing.id);
      focusCanvasWindow(existing.id);
    } else {
      openWindow(name, path);
    }
  }, [focusCanvasWindow, openWindow, wmRestoreAndFocusWindow]);

  // Keep every app entry point on one routing path. Some installed catalog
  // apps (notably Browser) intentionally map to shell-owned behavior instead
  // of AppViewer, so dock, command-palette, launcher, and deep-link launches
  // must all resolve them before opening a window.
  const openAppOrFocus = useCallback((path: string, name?: string) => {
    const builtInLaunch = resolveWebDesktopBuiltInLaunch(path);
    if (builtInLaunch?.kind === "external") {
      window.open(builtInLaunch.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (builtInLaunch?.kind === "external-code") {
      window.open(getCodeEditorUrl(), "_blank", "noopener,noreferrer");
      return;
    }
    if (builtInLaunch?.kind === "app") {
      focusOrOpen(builtInLaunch.name, builtInLaunch.path);
      return;
    }
    if (builtInLaunch?.kind === "os-view") {
      useDesktopMode.getState().setMode(builtInLaunch.mode);
      return;
    }
    focusOrOpen(name ?? apps.find((app) => app.path === path)?.name ?? "App", path);
  }, [apps, focusOrOpen]);

  const openSetupTerminal = (action: TerminalLaunchAction) => {
    const windows = useWindowManager.getState().windows;
    const focusedId = useWindowManager.getState().focusedWindowId;
    const focusedTerminal = windows.find((w) => w.id === focusedId && w.path.startsWith("__terminal__"));
    const setupTerminal = windows.find((w) => w.path === TERMINAL_SETUP_WINDOW_PATH);
    const existingTerminal = focusedTerminal ?? setupTerminal ?? windows.reduce<typeof windows[number] | undefined>(
      (best, w) =>
        w.path.startsWith("__terminal__") && (best === undefined || w.zIndex > best.zIndex) ? w : best,
      undefined,
    );
    if (existingTerminal) {
      wmRestoreAndFocusWindow(existingTerminal.id);
    } else {
      wmOpenWindow("Terminal", TERMINAL_SETUP_WINDOW_PATH, dockXOffset);
    }
    const resolveTargetTerminal = () => (
      existingTerminal
        ? useWindowManager.getState().getWindow(existingTerminal.id)
        : useWindowManager.getState().windows.find((w) => w.path === TERMINAL_SETUP_WINDOW_PATH)
    );

    requestAnimationFrame(() => {
      const win = resolveTargetTerminal();
      if (useDesktopMode.getState().mode === "canvas") {
        if (win) {
          const cRect = useCanvasTransform.getState().containerRect;
          useCanvasTransform.getState().focusOnWindow(
            win,
            cRect?.width ?? window.innerWidth,
            cRect?.height ?? window.innerHeight,
          );
        }
      }
      enqueueTerminalLaunch(action, win?.id);
    });
  };

  // Vocal mode's open_app tool and auto-open-after-build both go through
  // this. Fuzzy-matches `query` against the current apps list and focuses
  // (or opens) the best match. Returns the result so the caller can
  // report success/failure back to Gemini for accurate narration.
  const openAppByName = (query: string): { success: boolean; resolvedName?: string } => {
    const currentApps = useWindowManager.getState().apps;
    const match = findAppByName(currentApps, query);
    if (match) {
      openAppOrFocus(match.path, match.name);
      return { success: true, resolvedName: match.name };
    }
    return { success: false };
  };

  useEffect(() => {
    if (!launchAppPath || launchPathConsumedRef.current === launchAppPath) return;
    const match = useWindowManager.getState().apps.find((app) => app.path === launchAppPath);
    if (!match) return;
    launchPathConsumedRef.current = launchAppPath;
    openAppOrFocus(match.path, match.name);
  }, [apps, launchAppPath, openAppOrFocus]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity consumed by the module-load useEffect dependency array (L~1070); a fresh function each render would re-run the layout/modules/apps fetch on every render
  const loadModules = useCallback(async (signal?: AbortSignal) => {
    const isLoadAborted = () => signal?.aborted === true;
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

      const iconForSlug = (slug: string | undefined): string | undefined => {
        if (!slug) return undefined;
        return gatewayAssetUrl(bootstrap.icons?.[slug]?.versionedUrl) ?? iconUrlForSlug(slug);
      };

      const savedLayout: { windows?: LayoutWindow[] } =
        !isPreVpsBillingSetupRoute() ? bootstrap.layout ?? {} : {};
      const savedWindows = (savedLayout.windows ?? []).map(normalizeBuiltInLayoutWindow);
      const layoutMap = new Map(savedWindows.map((w) => [w.path, w]));

      const layoutToLoad: LayoutWindow[] = [];
      const queuedLayoutPaths = new Set<string>();
      const queueSavedLayout = (saved: LayoutWindow | undefined) => {
        if (!saved || queuedLayoutPaths.has(saved.path)) return;
        queuedLayoutPaths.add(saved.path);
        layoutToLoad.push(saved);
      };

      // Register built-in apps
      addApp("Terminal", "__terminal__", "terminal", iconForSlug("terminal"));
      addApp("Files", "__file-browser__", "files", iconForSlug("files"));
      if (!HERMES_CHAT_HIDDEN) {
        addApp("Hermes", "__chat__", "chat", iconForSlug("chat"));
      }
      const savedBuiltIns = savedWindows.filter((w) => isRestorableBuiltInAppPath(w.path));
      for (const saved of savedBuiltIns) {
        queueSavedLayout(saved);
      }

      // Load pre-installed apps from /api/apps (apps/ directory)
      if (Array.isArray(bootstrap.apps)) {
        const appsList = bootstrap.apps;
        const nextApiPaths = new Set(
          appsList.map((app) => normalizeBuiltInAppPath(app.path.replace(/^\/files\//, ""))),
        );
        const previousApiPaths = designApiPathsRef.current;
        // A cached bootstrap is applied before the authoritative network
        // bootstrap. Remove API-owned entries that disappeared from the fresh
        // list before adding its apps, otherwise an app from the cached OS
        // design survives a reload alongside the active design's apps.
        if (previousApiPaths.size > 0) {
          wmSetApps((current) => current.filter(
            (entry) => !previousApiPaths.has(entry.path) || nextApiPaths.has(entry.path),
          ));
        }
        // Baseline for the design-switch reconcile effect: removals only ever
        // apply to entries that came from /api/apps.
        designApiPathsRef.current = nextApiPaths;
        for (const app of appsList) {
          if (isLoadAborted()) return;
          // path from API is like "/files/apps/calculator/index.html"
          // strip leading "/files/" to get relative path for AppViewer
          const relativePath = normalizeBuiltInAppPath(app.path.replace(/^\/files\//, ""));
          const iconSlug = app.icon ?? app.slug;
          addApp(app.name, relativePath, iconSlug, iconForSlug(iconSlug));

          const saved = layoutMap.get(relativePath);
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
            addApp(mod.name, path, nameToSlug(mod.name));
            const saved = layoutMap.get(path);
            queueSavedLayout(saved);
            continue;
          }

          try {
            const relativeBasePath = registryPathToRelativePath(mod.path);
            if (!relativeBasePath) continue;

            const metaCandidates = relativeBasePath.startsWith("apps/")
              ? [
                  `${GATEWAY_URL}/files/${relativeBasePath}/matrix.json`,
                  `${GATEWAY_URL}/files/${relativeBasePath}/module.json`,
                  `${GATEWAY_URL}/files/${relativeBasePath}/manifest.json`,
                ]
              : [
                  `${GATEWAY_URL}/files/${relativeBasePath}/manifest.json`,
                  `${GATEWAY_URL}/files/${relativeBasePath}/module.json`,
                  `${GATEWAY_URL}/files/${relativeBasePath}/matrix.json`,
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
              addApp(appName, path, nameToSlug(appName));
              const saved = layoutMap.get(path);
              queueSavedLayout(saved);
              continue;
            }

            const meta = await readJsonForLoad<ModuleMeta>(metaRes);
            if (!meta) return;
            const entryFile = meta.entry ?? meta.entryPoint ?? "index.html";
            path = normalizeBuiltInAppPath(`${relativeBasePath}/${entryFile}`);
            appName = meta.name ?? mod.name;

            addApp(appName, path, meta.icon ?? nameToSlug(appName));

            const saved = layoutMap.get(path);
            if (saved) {
              queueSavedLayout(saved);
            } else {
              openWindow(appName, path);
            }
          } catch (err) {
            if (isLoadAborted()) return;
            console.warn(`[desktop] Failed to load module "${mod.name}":`, err);
          }
        }
      }

      if (isLoadAborted()) return;
      if (layoutToLoad.length > 0) {
        wmLoadLayout(layoutToLoad);
      }
    };

    try {
      const cachedBootstrap = loadShellSnapshot(cacheScope)?.bootstrap as ShellBootstrap | undefined;
      if (cachedBootstrap) {
        await applyBootstrap(cachedBootstrap, { resolveModuleMetadata: false });
      }

      const bootstrapRes = await fetchForLoad(`${GATEWAY_URL}/api/shell/bootstrap`).catch((err) => {
        if (isLoadAborted()) return null;
        console.warn("[desktop] Failed to fetch shell bootstrap:", err);
        return undefined;
      });
      if (bootstrapRes === null) return;
      const bootstrap = bootstrapRes?.ok ? await readJsonForLoad<ShellBootstrap>(bootstrapRes) : {};
      if (bootstrap === null) return;
      if (bootstrapRes?.ok) saveShellSnapshot(cacheScope, { bootstrap });
      await applyBootstrap(bootstrap, { resolveModuleMetadata: true });
    } catch (err) {
      if (isLoadAborted()) return;
      console.warn("[desktop] Failed to load desktop modules:", err);
    }
  }, [addApp, cacheScope, openWindow, wmLoadLayout]);

  useEffect(() => {
    const controller = new AbortController();
    void loadModules(controller.signal);
    return () => controller.abort();
  }, [loadModules]);

  useFileWatcher((path: string, event: string) => {
    if (path === "system/modules.json" && event !== "unlink") {
      loadModules();
      return;
    }

    if (path.startsWith("apps/")) {
      // Only react to actual app entry points, not every file under apps/
      const isRootHtml = path.match(/^apps\/[^/]+\.html$/);
      const isAppIndex = path.match(/^apps\/[^/]+\/(index\.html|dist\/index\.html)$/);
      if (!isRootHtml && !isAppIndex) return;

      const name = path.replace("apps/", "").replace(/\/(dist\/)?index\.html$/, "").replace(".html", "");
      if (event === "unlink") {
        wmSetApps((prev) => prev.filter((a) => a.path !== path));
        wmSetWindows((prev) => prev.filter((w) => w.path !== path));
      } else {
        addApp(name, path, nameToSlug(name));
      }
    }
  });

  const onDragStart = (id: string, e: React.PointerEvent) => {
    e.preventDefault();
    const win = wmGetWindow(id);
    if (!win) return;
    dragRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
    };
    setInteracting(true);
    wmFocusWindow(id);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { id, startX, startY, origX, origY } = dragRef.current;
    wmMoveWindow(id, origX + (e.clientX - startX), origY + (e.clientY - startY));
  };

  const onDragEnd = () => {
    dragRef.current = null;
    setInteracting(hasActiveWindowInteraction(dragRef.current, resizeRef.current));
  };

  const onResizeStart = (id: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const win = wmGetWindow(id);
    if (!win) return;
    resizeRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      origW: win.width,
      origH: win.height,
    };
    setInteracting(true);
    wmFocusWindow(id);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const { id, startX, startY, origW, origH } = resizeRef.current;
    wmResizeWindow(
      id,
      Math.max(MIN_WIDTH, origW + (e.clientX - startX)),
      Math.max(MIN_HEIGHT, origH + (e.clientY - startY)),
    );
  };

  const onResizeEnd = () => {
    resizeRef.current = null;
    setInteracting(hasActiveWindowInteraction(dragRef.current, resizeRef.current));
  };

  const [taskBoardOpen, setTaskBoardOpen] = useState(false);

  const register = useCommandStore((s) => s.register);
  const unregister = useCommandStore((s) => s.unregister);
  const desktopMode = useDesktopMode((s) => s.mode);
  const previousMode = useDesktopMode((s) => s.previousMode);
  const setDesktopMode = useDesktopMode((s) => s.setMode);
  const visibleModes = useDesktopMode((s) => s.visibleModes);
  const themeStyle = useThemeStyle();
  const osViewLayoutsRef = useRef(createOsViewLayoutMemory());
  // Windows designs replace the mac menu bar + dock with a bottom taskbar.
  const isWindowsDesign = themeStyle === "winxp" || themeStyle === "win11";

  // The gateway re-filters design-scoped apps on every /api/apps call, but
  // the shell only bootstraps its list once. Refetch on mid-session design
  // switches so scoped apps (XP Minesweeper, Widgets, Stickies…) appear and
  // disappear live without a reload.
  const designStyleRef = useRef<string | null>(null);
  useEffect(() => {
    if (!themeStyle) return;
    if (designStyleRef.current === null) {
      designStyleRef.current = themeStyle;
      return;
    }
    if (designStyleRef.current === themeStyle) return;
    designStyleRef.current = themeStyle;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${GATEWAY_URL}/api/apps`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok || cancelled) return;
        const apiApps = (await res.json()) as ApiAppEntry[];
        if (cancelled) return;
        const { next, apiPaths } = reconcileDesignApps({
          current: useWindowManager.getState().apps,
          apiApps,
          previousApiPaths: designApiPathsRef.current,
          normalizePath: (path) => normalizeBuiltInAppPath(path.replace(/^\/files\//, "")),
          iconUrlFor: (app) => iconUrlForSlug(app.icon ?? app.slug),
        });
        designApiPathsRef.current = apiPaths;
        wmSetApps(next);
      } catch (err) {
        if (!cancelled) {
          console.warn("[desktop] design app refresh failed:", err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [themeStyle, wmSetApps]);
  // Geometry belongs to the presentation namespace. Switching OS views keeps
  // canonical windows and sessions alive while restoring each view's last
  // in-memory geometry. Durable namespaced geometry follows in the persistence
  // slice; viewport reconciliation remains a renderer concern.
  useEffect(() => {
    if (!previousMode || previousMode === desktopMode) return;
    const currentWindows = useWindowManager.getState().windows;
    const transition = transitionOsViewLayout(
      osViewLayoutsRef.current,
      previousMode,
      desktopMode,
      currentWindows,
    );
    osViewLayoutsRef.current = transition.memory;
    useWindowManager.setState({ windows: transition.windows });
    if (desktopMode === "desktop") wmReconcileWindowsToViewport();
  }, [desktopMode, previousMode, wmReconcileWindowsToViewport]);

  // Aoede is orthogonal to mode now — a pointer-events-none overlay that
  // can ride on top of any mode. The dock button toggles it.
  const vocalActive = useVocalStore((s) => s.active);
  const toggleVocal = useVocalStore((s) => s.toggle);

  // Delayed unmount for the vocal overlay so the exit animation has time
  // to play. `active` flips instantly on toggle (so the mic/WS shut down),
  // but the DOM lingers for ~950ms after to let the fade-out finish. The
  // setState-in-effect lint warns about cascading renders but this is a
  // legitimate delayed-unmount primitive — effect depends on vocalActive,
  // not on vocalMounted, so there's no cascade loop.
  const [vocalMounted, setVocalMounted] = useState(vocalActive);
  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- delayed-unmount animation primitive: mount immediately when active, defer unmount via a timer so the fade-out can play; the effect depends on vocalActive (not vocalMounted), so these setStates are timer-sequenced, not a cascade loop
  useEffect(() => {
    if (vocalActive) {
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- mount the overlay synchronously when activated; cannot be derived because the exit window is timer-driven (DOM lingers ~950ms after vocalActive flips false)
      setVocalMounted(true);
      return;
    }
    const t = setTimeout(() => setVocalMounted(false), 950);
    return () => clearTimeout(t);
  }, [vocalActive]);

  const toggleMcRef = useRef(() => { setTaskBoardOpen((prev) => !prev); setSettingsOpen(false); });

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- false positive: the setState calls counted here (setDesktopMode, setSettingsOpen, setTaskBoardOpen) live inside command `execute` handlers that only fire on user invocation; this effect just registers/unregisters command-palette entries and runs no setState synchronously, so there is no render cascade
  useEffect(() => {
    const modeCommands = visibleModes().map((m) => ({
      id: `mode:${m.id}`,
      label: `Mode: ${m.label}`,
      group: "Actions" as const,
      keywords: ["mode", "layout", m.id, m.description],
      execute: () => {
        setDesktopMode(m.id);
      },
    }));

    register([
      {
        id: "action:toggle-mc",
        label: "Toggle Mission Control",
        group: "Actions",
        shortcut: "F3",
        keywords: ["tasks", "kanban", "dashboard"],
        execute: () => toggleMcRef.current(),
      },
      {
        id: "action:open-settings",
        label: "Open Settings",
        group: "Actions",
        shortcut: "Cmd+,",
        keywords: ["settings", "preferences", "config", "configure"],
        execute: () => { setSettingsOpen((prev) => !prev); setTaskBoardOpen(false); },
      },
      {
        id: "action:open-file-browser",
        label: "Open File Browser",
        group: "Actions",
        keywords: ["files", "finder", "browse", "explorer"],
        execute: () => openWindow("Files", "__file-browser__"),
      },
      {
        id: "action:toggle-vocal",
        label: "Toggle Aoede",
        group: "Actions",
        keywords: ["aoede", "vocal", "voice", "mic", "talk"],
        execute: () => toggleVocal(),
      },
      ...modeCommands,
      // File menu commands
      {
        id: "file:new-window",
        label: "New Terminal Window",
        group: "File",
        keywords: ["new", "window", "terminal"],
        execute: () => openWindow("Terminal", "__terminal__"),
      },
      {
        id: "file:close-window",
        label: "Close Window",
        group: "File",
        shortcut: "Cmd+W",
        keywords: ["close", "window", "quit"],
        execute: () => {
          const focused = useWindowManager.getState().getFocusedWindow();
          if (focused) wmCloseWindow(focused.id);
        },
      },
      {
        id: "file:minimize-window",
        label: "Minimize Window",
        group: "File",
        shortcut: "Cmd+M",
        keywords: ["minimize", "hide", "window"],
        execute: () => {
          const focused = useWindowManager.getState().getFocusedWindow();
          if (focused) animateMinimize(focused.id);
        },
      },
      // Edit menu commands
      {
        id: "edit:undo",
        label: "Undo",
        group: "Edit",
        shortcut: "Cmd+Z",
        keywords: ["undo", "revert"],
        execute: () => document.execCommand("undo"),
      },
      {
        id: "edit:redo",
        label: "Redo",
        group: "Edit",
        keywords: ["redo"],
        execute: () => document.execCommand("redo"),
      },
      {
        id: "edit:cut",
        label: "Cut",
        group: "Edit",
        shortcut: "Cmd+X",
        keywords: ["cut", "clipboard"],
        execute: async () => {
          const sel = window.getSelection();
          if (sel && sel.toString()) {
            await navigator.clipboard.writeText(sel.toString());
            document.execCommand("delete");
          }
        },
      },
      {
        id: "edit:copy",
        label: "Copy",
        group: "Edit",
        shortcut: "Cmd+C",
        keywords: ["copy", "clipboard"],
        execute: async () => {
          const sel = window.getSelection();
          if (sel && sel.toString()) {
            await navigator.clipboard.writeText(sel.toString());
          }
        },
      },
      {
        id: "edit:paste",
        label: "Paste",
        group: "Edit",
        shortcut: "Cmd+V",
        keywords: ["paste", "clipboard"],
        execute: async () => {
          try {
            const text = await navigator.clipboard.readText();
            document.execCommand("insertText", false, text);
          } catch (err) {
            console.warn("[desktop] Clipboard read denied:", err);
          }
        },
      },
      {
        id: "edit:select-all",
        label: "Select All",
        group: "Edit",
        shortcut: "Cmd+A",
        keywords: ["select", "all"],
        execute: () => document.execCommand("selectAll"),
      },
      // View menu commands
      {
        id: "view:reload-app",
        label: "Reload App",
        group: "View",
        shortcut: "Cmd+R",
        keywords: ["reload", "refresh", "app"],
        execute: () => {
          const focused = useWindowManager.getState().getFocusedWindow();
          if (!focused) return;
          const iframe = document.querySelector(`[data-window-id="${focused.id}"] iframe`) as HTMLIFrameElement | null;
          if (iframe) iframe.src = iframe.src;
        },
      },
      {
        id: "view:fullscreen",
        label: "Enter Full Screen",
        group: "View",
        keywords: ["fullscreen", "full", "screen", "maximize"],
        execute: () => {
          const focused = useWindowManager.getState().getFocusedWindow();
          if (!focused) return;
          wmToggleFullscreen(focused.id);
        },
      },
    ]);
    return () => unregister([
      "action:toggle-mc",
      "action:open-settings",
      "action:open-file-browser",
      "action:toggle-vocal",
      "file:new-window",
      "file:close-window",
      "file:minimize-window",
      "edit:undo",
      "edit:redo",
      "edit:cut",
      "edit:copy",
      "edit:paste",
      "edit:select-all",
      "view:reload-app",
      "view:fullscreen",
      ...visibleModes().map((m) => `mode:${m.id}`),
    ]);
  }, [register, unregister, visibleModes, setDesktopMode, openWindow, animateMinimize, wmCloseWindow, toggleVocal, wmToggleFullscreen]);

  useEffect(() => {
    const appCommands = apps.map((app) => ({
      id: `app:${app.path}`,
      label: app.name,
      group: "Apps" as const,
      icon: app.iconUrl,
      keywords: [app.path],
      execute: () => openAppOrFocus(app.path, app.name),
    }));
    if (appCommands.length > 0) register(appCommands);
    return () => unregister(apps.map((a) => `app:${a.path}`));
  }, [apps, openAppOrFocus, register, unregister]);

  useEffect(() => {
    if (!fullscreenWindowId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) wmExitFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreenWindowId, wmExitFullscreen]);

  const canvasToolbarChild = desktopMode === "canvas" ? (
    <CanvasToolbar
      guideVisible={manualSetupVisible}
      onOpenGuide={() => setManualSetupVisible(true)}
    />
  ) : null;

  const launcherApps = useMemo(
    () => buildWebDesktopLauncherApps(apps, desktopMode),
    [apps, desktopMode],
  );

  const reconcileLauncherApps = useCallback((apiApps: ApiAppEntry[]) => {
    const { next, apiPaths } = reconcileDesignApps({
      current: useWindowManager.getState().apps,
      apiApps,
      previousApiPaths: designApiPathsRef.current,
      normalizePath: (path) => normalizeBuiltInAppPath(path.replace(/^\/files\//, "")),
      iconUrlFor: (app) => iconUrlForSlug(app.icon ?? app.slug),
    });
    designApiPathsRef.current = apiPaths;
    wmSetApps(next);
  }, [wmSetApps]);

  const openLauncherDestination = useCallback((name: string, path: string) => {
    if (path === "__settings__" || path === "__plugins__") {
      setSettingsDefaultSection(path === "__plugins__" ? "integrations" : "appearance");
      setSettingsOpen(true);
      setTaskBoardOpen(false);
      setChatOpen(false);
      return;
    }
    openAppOrFocus(path, name);
    setTaskBoardOpen(false);
  }, [openAppOrFocus]);

  if (firstRunStatus === "checking") {
    return (
      <TooltipProvider delayDuration={300}>
        <ShellNotificationStack>
          <RuntimeIdentityBanner />
        </ShellNotificationStack>
        <MatrixLoadingScreen />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <ShellNotificationStack>
        <RuntimeIdentityBanner />
        <ConnectionIndicator />
      </ShellNotificationStack>
      {desktopMode !== "desktop" && (isWindowsDesign ? (
        <WindowsTaskbar
          themeStyle={themeStyle}
          apps={apps}
          windows={windows}
          onOpenApp={openAppOrFocus}
          onFocusWindow={(id) => { wmRestoreAndFocusWindow(id); focusCanvasWindow(id); }}
          onMinimizeWindow={animateMinimize}
          onOpenSettings={() => { setSettingsOpen(true); setTaskBoardOpen(false); setChatOpen(false); }}
          onOpenCommandPalette={onOpenCommandPalette ?? (() => {})}
        >
          {canvasToolbarChild}
        </WindowsTaskbar>
      ) : canvasToolbarChild)}
      <OsSessionHost />
      <div className="relative flex-1 flex flex-col md:flex-row">
        {/* Desktop dock -- hidden in ambient/conversational modes. */}
        {desktopMode !== "desktop" && !isWindowsDesign && <div
          className={[
            "hidden md:block fixed z-[55]",
            dock.position === "left" && "left-0 top-0 h-full",
            dock.position === "right" && "right-0 top-0 h-full",
            dock.position === "bottom" && "bottom-0 left-0 w-full",
            dock.autoHide ? (isHorizontal ? "w-full h-3" : "w-3 h-full") : "",
            !dock.autoHide && "pointer-events-none",
            "group/dock",
          ].filter(Boolean).join(" ")}
          style={!dock.autoHide ? {
            width: isHorizontal ? "100%" : dock.size + 16,
            height: isHorizontal ? dock.size + 16 : "100%",
          } : undefined}
        >
        <aside
          data-dock
          className={[
            "pointer-events-auto flex items-center gap-1.5 bg-card/50 backdrop-blur-md transition-all duration-200 rounded-2xl border border-border/30 shadow-lg",
            isHorizontal ? "flex-row px-2" : "flex-col py-2",
            dock.position === "left" && "fixed left-2 top-1/2 -translate-y-1/2",
            dock.position === "right" && "fixed right-2 top-1/2 -translate-y-1/2",
            dock.position === "bottom" && "fixed bottom-2 left-1/2 -translate-x-1/2",
            dock.autoHide && dock.position === "left" && "-translate-x-[calc(100%+8px)] group-hover/dock:translate-x-0",
            dock.autoHide && dock.position === "right" && "translate-x-[calc(100%+8px)] group-hover/dock:translate-x-0",
            dock.autoHide && dock.position === "bottom" && "translate-y-[calc(100%+8px)] group-hover/dock:translate-y-0",
            dock.autoHide && (dock.position === "left" || dock.position === "right") && "-translate-y-1/2",
          ].filter(Boolean).join(" ")}
          style={{ padding: 6 }}
        >
          {/* User-generated apps section: pinned + open user apps. Sorted
              by recency by default; reorderable via framer-motion's
              Reorder. The macOS-Dock feel (real icon follows the pointer,
              neighbors slide aside) needs pointer-event drag + layout
              animations on siblings -- HTML5 DnD can't deliver that
              because its drag image is a static bitmap and the source
              element stays in place. */}
          {(() => {
            const pinnedSet = new Set(pinnedApps);
            const visibleWindowPaths = windows.reduce<string[]>((acc, w) => {
              if (!w.minimized) acc.push(w.path);
              return acc;
            }, []);
            const hasVisibleWindow = (appPath: string) =>
              visibleWindowPaths.some((wp) => wp === appPath || wp.startsWith(appPath + ":"));

            const userAppsRaw = apps.filter(
              (a) => !isMainSectionApp(a.path) && (pinnedSet.has(a.path) || hasVisibleWindow(a.path)),
            );
            const userApps = applyOrder(userAppsRaw, dockOrder?.userApps, appLaunchTimes);
            if (userApps.length === 0) return null;

            return (
              <Reorder.Group
                as="div"
                axis={isHorizontal ? "x" : "y"}
                values={userApps.map((a) => a.path)}
                onReorder={(newOrder: string[]) => reorderDockSection("userApps", newOrder)}
                className={isHorizontal
                  ? "flex flex-row items-center gap-1"
                  : "flex flex-col items-center gap-1"
                }
                data-dock-section="user"
                style={{ order: 2 }}
              >
                {userApps.map((app) => {
                  const hasAny = hasVisibleWindow(app.path);
                  return (
                    <Reorder.Item
                      key={app.path}
                      value={app.path}
                      as="div"
                      // touch-none keeps touch drags from scrolling the page
                      // mid-reorder. cursor-grab signals the affordance.
                      className="cursor-grab touch-none active:cursor-grabbing"
                      // macOS-style lift: scale + shadow + zIndex so the
                      // dragged icon visually detaches from the dock.
                      whileDrag={{
                        scale: 1.18,
                        zIndex: 50,
                        boxShadow: "0 12px 32px -8px rgba(0,0,0,0.35)",
                      }}
                      // Snappy spring on settle.
                      transition={{ type: "spring", stiffness: 600, damping: 38 }}
                    >
                      <DockIcon
                        name={app.name}
                        active={hasAny}
                        onClick={() => openAppOrFocus(app.path, app.name)}
                        iconSize={dock.iconSize}
                        tooltipSide={tooltipSide}
                        iconUrl={app.iconUrl}
                        onUnpin={pinnedSet.has(app.path) ? () => togglePin(app.path) : undefined}
                        onRegenerateIcon={() => regenerateIcon(nameToSlug(app.name))}
                        onRename={(newName) => renameAppOnServer(nameToSlug(app.name), newName)}
                        onQuit={() => removeFromCanvas(app.path)}
                        canQuit={hasAny}
                      />
                    </Reorder.Item>
                  );
                })}
              </Reorder.Group>
            );
          })()}

          {/* Minimized windows — each gets its own dock icon with entrance animation */}
          {(() => {
            const minimizedWindows = windows.filter((w) => w.minimized);
            if (minimizedWindows.length === 0) return null;
            const appIconMap = new Map(apps.map((a) => [a.path, a.iconUrl]));
            const getIconForWindow = (winPath: string) => {
              const basePath = winPath.split(":")[0];
              return appIconMap.get(basePath) ?? appIconMap.get(winPath);
            };
            return (
              <div className={isHorizontal
                ? "flex flex-row items-center gap-1"
                : "flex flex-col items-center gap-1"
              } style={{ order: 2 }}>
                <div
                  className={isHorizontal ? "h-6 border-l border-border/40" : "w-6 border-t border-border/40"}
                  style={{ animation: "dock-sep-in 300ms ease-out both" }}
                />
                {minimizedWindows.map((win, i) => (
                  <div
                    key={`min-${win.id}`}
                    style={{
                      animation: `dock-icon-in 400ms cubic-bezier(0.34, 1.56, 0.64, 1) ${100 + i * 60}ms both`,
                    }}
                  >
                    <DockIcon
                      name={win.title}
                      active={false}
                      onClick={() => {
                        wmRestoreAndFocusWindow(win.id);
                        focusCanvasWindow(win.id);
                      }}
                      iconSize={Math.round(dock.iconSize * 0.8)}
                      tooltipSide={tooltipSide}
                      iconUrl={getIconForWindow(win.path)}
                    />
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Bold divider between user apps / minimized and the system
              section below. This is the visible "main vs other apps"
              boundary the user asked for. */}
          <div
            className={isHorizontal
              ? "h-8 w-px bg-border/60 mx-1"
              : "w-8 h-px bg-border/60 my-1"
            }
            aria-hidden
            style={{ order: 1 }}
          />

          {/* System cluster: built-in apps (Terminal, Files, Preview if
              pinned/open) followed by system controls. Launcher sits
              above Chat per spec. This is the "main apps every user has"
              section -- always at the dock's inner edge. */}
          {(() => {
            const pinnedSet = new Set(pinnedApps);
            const visibleWindowPaths = windows.reduce<string[]>((acc, w) => {
              if (!w.minimized) acc.push(w.path);
              return acc;
            }, []);
            const hasVisibleWindow = (appPath: string) =>
              visibleWindowPaths.some((wp) => wp === appPath || wp.startsWith(appPath + ":"));
            const systemAppsRaw = apps.filter(
              // Terminal is pinned as a control button above; keep it out of
              // the apps row so it isn't shown twice.
              (a) => a.path !== "__terminal__" && isMainSectionApp(a.path) && (pinnedSet.has(a.path) || hasVisibleWindow(a.path)),
            );
            const systemApps = applyOrder(systemAppsRaw, dockOrder?.systemApps, appLaunchTimes);
            return (
              <div className={isHorizontal
                ? "flex flex-row items-center gap-1"
                : "flex flex-col items-center gap-1"
              } style={{ order: 0 }}>
                {/* Apps render BELOW the launcher/settings controls (order:10
                    pushes this group after the default-order system buttons). */}
                <div
                  className={isHorizontal ? "flex flex-row items-center gap-1" : "flex flex-col items-center gap-1"}
                  style={{ order: 10 }}
                >
                {systemApps.map((app) => {
                  const hasAny = hasVisibleWindow(app.path);
                  return (
                    <DockIcon
                      key={app.path}
                      name={app.name}
                      active={hasAny}
                      onClick={() => openAppOrFocus(app.path, app.name)}
                      iconSize={dock.iconSize}
                      tooltipSide={tooltipSide}
                      iconUrl={app.iconUrl}
                      onUnpin={pinnedSet.has(app.path) ? () => togglePin(app.path) : undefined}
                      onQuit={() => removeFromCanvas(app.path)}
                      canQuit={hasAny}
                    />
                  );
                })}
                </div>
                {(
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        data-testid="dock-tasks"
                        onClick={() => { setTaskBoardOpen((prev) => !prev); setSettingsOpen(false); setChatOpen(false); }}
                        className={`flex items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all ${
                          taskBoardOpen
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-card border-border/60"
                        }`}
                        style={{ width: dock.iconSize, height: dock.iconSize }}
                      >
                        <LayoutGridIcon className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side={tooltipSide} sideOffset={8}>
                      Launcher
                    </TooltipContent>
                  </Tooltip>
                )}
                {/* Terminal pinned in the controls row, between launcher and
                    VS Code. Rendered via DockIcon so the green app icon fills
                    the tile like the other app icons (not a tiny inset glyph),
                    and isn't duplicated in the apps row below. */}
                {(() => {
                  const terminalApp = apps.find((a) => a.path === "__terminal__");
                  const terminalActive = windows.some((w) => !w.minimized && (w.path === "__terminal__" || w.path.startsWith("__terminal__:")));
                  return (
                    <DockIcon
                      name="Terminal"
                      active={terminalActive}
                      onClick={() => focusOrOpen("Terminal", "__terminal__")}
                      iconSize={dock.iconSize}
                      tooltipSide={tooltipSide}
                      iconUrl={terminalApp?.iconUrl ?? iconUrlForSlug("terminal")}
                    />
                  );
                })()}
                {!HERMES_CHAT_HIDDEN && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid="dock-chat"
                      onClick={() => { setChatOpen((v) => !v); setTaskBoardOpen(false); setSettingsOpen(false); }}
                      className={`relative flex items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all ${
                        chatOpen
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-card border-border/60"
                      }`}
                      style={{ width: dock.iconSize, height: dock.iconSize }}
                      aria-label={chatOpen ? "Close Hermes" : "Open Hermes"}
                    >
                      <MessageSquareIcon className="size-4" />
                      {chat?.busy && (
                        <span
                          className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-primary"
                          aria-hidden
                        />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side={tooltipSide} sideOffset={8}>Hermes</TooltipContent>
                </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid="dock-vscode"
                      onClick={() => window.open(getCodeEditorUrl(), "_blank", "noopener,noreferrer")}
                      className="flex items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all bg-card border-border/60"
                      style={{ width: dock.iconSize, height: dock.iconSize }}
                    >
                      {/* react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- small static dock icon from /public; next/image is overkill for a 20px square */}
                      <img src="/vscode.png" alt="VS Code" className="size-5 rounded-[5px]" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side={tooltipSide} sideOffset={8}>Code editor</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid="dock-settings"
                      onClick={() => { setSettingsOpen((prev) => !prev); setTaskBoardOpen(false); setChatOpen(false); }}
                      className={`flex items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all ${
                        settingsOpen
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-card border-border/60"
                      }`}
                      style={{ width: dock.iconSize, height: dock.iconSize }}
                    >
                      <SettingsIcon className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side={tooltipSide} sideOffset={8}>
                    Settings
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })()}

          {/* Aoede lives on its own line below the system cluster. It's
              not an app or a setting — it's an ambient presence that can
              ride on top of any mode, so it gets a distinct circular
              shape and a primary-glow halo instead of the square dock
              icons. The active state breathes to echo the vocal overlay. */}
          {!VOICE_HIDDEN && (
            <>
              <div
                className={isHorizontal
                  ? "h-6 w-px bg-border/40 mx-1.5"
                  : "w-6 h-px bg-border/40 my-1.5"
                }
                aria-hidden
              />
              <AoedeDockButton size={dock.iconSize} variant="desktop" tooltipSide={tooltipSide} />
            </>
          )}

        </aside>
        </div>}

        {/* Mobile dock (bottom tab bar) */}
        {desktopMode !== "desktop" && (
          <nav className="flex md:hidden items-center gap-1 px-2 py-1.5 border-t border-border/40 bg-card/80 backdrop-blur-sm order-last overflow-x-auto z-[55]">
            {!HERMES_CHAT_HIDDEN && (
            <button
              type="button"
              data-testid="dock-chat-mobile"
              onClick={() => { setChatOpen((v) => !v); setTaskBoardOpen(false); setSettingsOpen(false); }}
              className={`relative flex shrink-0 size-9 items-center justify-center rounded-lg border transition-all active:scale-95 ${
                chatOpen
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border/60"
              }`}
              aria-label={chatOpen ? "Close Hermes" : "Open Hermes"}
            >
              <MessageSquareIcon className="size-4" />
              {chat?.busy && (
                <span
                  className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-primary"
                  aria-hidden
                />
              )}
            </button>
            )}
            {(
              <button
                type="button"
                onClick={() => { setTaskBoardOpen((prev) => !prev); setSettingsOpen(false); setChatOpen(false); }}
                className={`flex shrink-0 size-9 items-center justify-center rounded-lg border transition-all active:scale-95 ${
                  taskBoardOpen
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card border-border/60"
                }`}
              >
                <LayoutGridIcon className="size-4" />
              </button>
            )}            <button
              type="button"
              onClick={() => { setSettingsOpen((prev) => !prev); setTaskBoardOpen(false); setChatOpen(false); }}
              className={`flex shrink-0 size-9 items-center justify-center rounded-lg border transition-all active:scale-95 ${
                settingsOpen
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border/60"
              }`}
              title="Settings"
            >
              <SettingsIcon className="size-4" />
            </button>
            <div className="h-6 w-px bg-border/40 mx-0.5 shrink-0" aria-hidden />
            {!VOICE_HIDDEN && <AoedeDockButton size={36} variant="mobile" />}
            <div className="shrink-0">
              <UserButton />
            </div>
            {apps.reduce<ReactNode[]>((acc, app) => {
              if (!pinnedApps.includes(app.path)) return acc;
              const win = windows.find(
                (w) => w.path === app.path && !w.minimized,
              );
              acc.push(
                <button
                  type="button"
                  key={app.path}
                  onClick={() => openAppOrFocus(app.path, app.name)}
                  className={`flex shrink-0 h-9 items-center gap-1.5 px-3 rounded-lg border transition-all active:scale-95 ${
                    win
                      ? "bg-primary/10 border-primary/30 text-foreground"
                      : "bg-card border-border/60 text-muted-foreground"
                  }`}
                >
                  <span className="text-xs font-medium truncate max-w-[80px]">{app.name}</span>
                </button>,
              );
              return acc;
            }, [])}
          </nav>
        )}

        <div className="relative flex-1 min-h-0 overflow-hidden">
          <DotGrid />
          {desktopMode === "desktop" ? (
            <WebDesktopSurface
              apps={apps}
              windows={windows}
              fullscreenWindowId={fullscreenWindowId}
              launcherOpen={taskBoardOpen}
              onOpenApp={openAppOrFocus}
              onOpenLauncher={() => {
                setTaskBoardOpen((open) => !open);
                setSettingsOpen(false);
                setChatOpen(false);
              }}
              headerActions={(
                <WebDesktopControls
                  onOpenCommandPalette={onOpenCommandPalette ?? (() => {})}
                  onOpenSupport={() => void openShellSupport()}
                  onOpenSettings={(section) => {
                    setSettingsDefaultSection(section);
                    setSettingsOpen(true);
                    setTaskBoardOpen(false);
                    setChatOpen(false);
                  }}
                />
              )}
              onOpenSettings={(section: WebDesktopSettingsSection) => {
                setSettingsDefaultSection(section);
                setSettingsOpen(true);
                setTaskBoardOpen(false);
                setChatOpen(false);
              }}
              onActivateWindow={(id) => wmRestoreAndFocusWindow(id)}
              onCloseWindow={wmCloseWindow}
              onShowDesktop={() => {
                wmExitFullscreen();
                for (const windowRecord of windows) {
                  if (!windowRecord.minimized) animateMinimize(windowRecord.id);
                }
              }}
              onToggleFullscreen={wmToggleFullscreen}
              desktopIcons={desktopIcons}
              onMoveDesktopIcon={moveDesktopIcon}
              onRemoveDesktopIcon={removeDesktopIcon}
            />
          ) : null}
          {/* XP desktop icons: above the wallpaper, below app windows. The
              component self-gates to the winxp design and renders null
              otherwise. */}
          {desktopMode !== "desktop" ? <XpDesktopIcons onOpenApp={openAppOrFocus} /> : null}
          <MissionControl
            open={taskBoardOpen}
            nativePresentation={desktopMode === "desktop"}
            apps={launcherApps}
            openWindows={windows.reduce<Set<string>>((acc, w) => {
              if (!w.minimized) acc.add(w.path);
              return acc;
            }, new Set())}
            onOpenApp={openLauncherDestination}
            onClose={() => setTaskBoardOpen(false)}
            pinnedApps={pinnedApps}
            onTogglePin={togglePin}
            onRegenerateIcon={regenerateIcon}
            onRenameApp={renameAppOnServer}
            onRemoveFromCanvas={removeFromCanvas}
            onCreateApp={() => {
              focusOrOpen("Chat", "__chat__");
              chat?.requestComposerDraft("/matrix-app-builder ");
            }}
            onAddToDesktop={addDesktopIcon}
            onAppsRefreshed={reconcileLauncherApps}
          />

          {desktopMode === "canvas" && (
            <CanvasRenderer>
              {manualSetupVisible && (
                <SetupChecklist onOpenTerminal={openSetupTerminal} />
              )}
            </CanvasRenderer>
          )}

          {vocalMounted && (
            <VocalPanel
              active={vocalActive}
              chat={chat}
              onOpenApp={openAppByName}
              onDismissChat={() => setChatOpen(false)}
            />
          )}

          {desktopMode !== "canvas" && windows.filter((w) => !w.minimized).length === 0 &&
            apps.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-white/50 drop-shadow-md">
                  No apps running. Try &quot;Build me a notes app&quot; in
                  the chat.
                </p>
              </div>
            )}

          {/* Desktop: positioned windows; Mobile: full-screen cards.
              We render minimized windows too (display:none) so iframe state,
              terminal sockets, and React state survive minimize -> restore. */}
          {desktopMode !== "canvas" && windows.map((win) => (
            <DesktopWindow
              key={win.id}
              win={win}
              chat={chat}
              dockPosition={desktopMode === "desktop" ? "bottom" : dock.position}
              fullscreenWindowId={fullscreenWindowId}
              interacting={interacting}
              minimizingIds={minimizingIds}
              onAnimateMinimize={animateMinimize}
              onCloseWindow={wmCloseWindow}
              onDragEnd={onDragEnd}
              onDragMove={onDragMove}
              onDragStart={onDragStart}
              onFocusWindow={wmFocusWindow}
              onOpenWindow={openWindow}
              onResizeEnd={onResizeEnd}
              onResizeMove={onResizeMove}
              onResizeStart={onResizeStart}
              onToggleFullscreen={wmToggleFullscreen}
              topInset={desktopMode === "desktop" ? 38 : 0}
            />
          ))}
        </div>
      </div>

      <Settings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        defaultSection={settingsDefaultSection}
        onOpenAgentTerminal={(action) => {
          setSettingsOpen(false);
          openSetupTerminal(action);
        }}
      />
      {/* Single ChatPopover instance shared by desktop + mobile dock
          buttons. Lives outside both dock-orientation branches so it
          isn't unmounted when the viewport orientation flips. */}
      <ChatPopover open={chatOpen} onOpenChange={setChatOpen} />

      {/* No fullscreen exit pill: every maximized window keeps its own header
          (Desktop CardHeader / Canvas in-window title bar) with traffic lights,
          and Escape still exits fullscreen as a keyboard fallback. */}
    </TooltipProvider>
  );
}
