"use client";

import { useState, useCallback, useEffect, useRef, useId } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { useWindowManager, type LayoutWindow } from "@/hooks/useWindowManager";
import { useCommandStore } from "@/stores/commands";
import { useDesktopMode } from "@/stores/desktop-mode";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useDesktopConfigStore } from "@/stores/desktop-config";
import { saveDesktopConfig } from "@/hooks/useDesktopConfig";
import { AppViewer } from "./AppViewer";
import { TerminalApp } from "./terminal/TerminalApp";
import { FileBrowser } from "./file-browser/FileBrowser";
import { PreviewWindow } from "./preview-window/PreviewWindow";
import { AIButton } from "./AIButton";
import { MissionControl } from "./MissionControl";
import { DotGrid } from "./DotGrid";
import { Settings } from "./Settings";
import { CanvasRenderer } from "./canvas/CanvasRenderer";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { KanbanSquareIcon, MonitorIcon, SettingsIcon, PinOffIcon, RefreshCwIcon, CheckIcon, PencilIcon, XCircleIcon } from "lucide-react";
import { UserButton } from "./UserButton";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { AmbientClock } from "./AmbientClock";
import { OnboardingScreen } from "./OnboardingScreen";
import { MenuBar } from "./MenuBar";
import { CanvasToolbar } from "./canvas/CanvasToolbar";
import { VocalPanel } from "./VocalPanel";
import { getGatewayUrl } from "@/lib/gateway";
import { ChatApp } from "./ChatApp";
import { versionedIconUrl } from "@/lib/icon-url";
import { nameToSlug } from "@/lib/utils";

const GATEWAY_URL = getGatewayUrl();
const GATEWAY_FETCH_TIMEOUT_MS = 10_000;

// Forgiving app-name lookup used by vocal mode's `open_app` tool and the
// auto-open after a build finishes. Handles exact, substring, reverse
// substring, and word-level matches so "notes", "the notes", "notes app",
// and "my notes" all resolve to the same installed app.
function findAppByName<T extends { name: string }>(apps: T[], query: string): T | null {
  const q = query.toLowerCase().trim().replace(/[^\w\s]+/g, "").replace(/\s+/g, " ");
  if (!q) return null;

  const exact = apps.find((a) => a.name.toLowerCase() === q);
  if (exact) return exact;

  // Query ⊂ app name — prefer shortest match (most specific).
  const contains = apps.filter((a) => a.name.toLowerCase().includes(q));
  if (contains.length > 0) {
    return [...contains].sort((a, b) => a.name.length - b.name.length)[0];
  }

  // App name ⊂ query ("open the notes app" contains "Notes") — prefer longest.
  const reverse = apps.filter((a) => q.includes(a.name.toLowerCase()));
  if (reverse.length > 0) {
    return [...reverse].sort((a, b) => b.name.length - a.name.length)[0];
  }

  // Word-level: at least half the query's meaningful words appear in
  // the app name. Stopwords (single chars) are filtered out.
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  if (words.length > 0) {
    const scored = apps
      .map((a) => {
        const nameLower = a.name.toLowerCase();
        const hits = words.filter((w) => nameLower.includes(w)).length;
        return { app: a, score: hits / words.length };
      })
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score || a.app.name.length - b.app.name.length);
    if (scored.length > 0) return scored[0].app;
  }

  return null;
}

interface ModuleRegistryEntry {
  name: string;
  type: string;
  path: string;
  status: string;
}

interface ModuleMeta {
  name: string;
  entry?: string;
  entryPoint?: string;
  icon?: string;
  version?: string;
}

function registryPathToRelativePath(path: string): string | null {
  if (path.startsWith("~/")) {
    return path.slice(2);
  }
  const homePrefix = "/home/matrixos/home/";
  if (path.startsWith(homePrefix)) {
    return path.slice(homePrefix.length);
  }
  return null;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

function TrafficLights({
  onClose,
  onMinimize,
}: {
  onClose: () => void;
  onMinimize: () => void;
}) {
  return (
    <div className="group/traffic flex items-center gap-1.5 mr-2">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="size-3 rounded-full bg-[#ff5f57] flex items-center justify-center hover:brightness-90 transition-colors"
        aria-label="Close"
      >
        <span className="text-[8px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
          x
        </span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onMinimize();
        }}
        className="size-3 rounded-full bg-[#febc2e] flex items-center justify-center hover:brightness-90 transition-colors"
        aria-label="Minimize"
      >
        <span className="text-[9px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
          -
        </span>
      </button>
      <button
        className="size-3 rounded-full bg-[#28c840] flex items-center justify-center hover:brightness-90 transition-colors"
        aria-label="Maximize"
      />
    </div>
  );
}

function DockIcon({
  name,
  active,
  onClick,
  iconSize = 40,
  tooltipSide = "right",
  iconUrl,
  onUnpin,
  onRegenerateIcon,
  onRename,
  onQuit,
  canQuit,
}: {
  name: string;
  active: boolean;
  onClick: () => void;
  iconSize?: number;
  tooltipSide?: "left" | "right" | "top" | "bottom";
  iconUrl?: string;
  onUnpin?: () => void;
  onRegenerateIcon?: () => void;
  onRename?: (newName: string) => void;
  onQuit?: () => void;
  canQuit?: boolean;
}) {
  const initial = name.charAt(0).toUpperCase();
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const showIcon = iconUrl && failedIconUrl !== iconUrl;

  const btn = (
    <button
      onClick={onClick}
      className={`relative flex items-center justify-center rounded-xl shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all overflow-hidden ${
        showIcon ? "" : "bg-card border border-border/60"
      }`}
      style={{ width: iconSize, height: iconSize }}
    >
      {showIcon ? (
        // eslint-disable-next-line @next/next/no-img-element -- dock icons are dynamic files served by the gateway
        <img
          key={iconUrl}
          src={iconUrl}
          alt={name}
          className="size-full object-cover rounded-xl"
          onError={() => setFailedIconUrl(iconUrl)}
        />
      ) : (
        <span className="text-sm font-semibold text-foreground">
          {initial}
        </span>
      )}
      {active && (
        <span className="absolute -right-1 top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-foreground" />
      )}
    </button>
  );

  const hasContextMenu = onUnpin || onRegenerateIcon || onRename || onQuit;
  if (!hasContextMenu) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side={tooltipSide} sideOffset={8}>{name}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <Tooltip>
            <TooltipTrigger asChild>{btn}</TooltipTrigger>
            <TooltipContent side={tooltipSide} sideOffset={8}>{name}</TooltipContent>
          </Tooltip>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[60]">
        {onUnpin && (
          <ContextMenuItem onSelect={onUnpin}>
            <PinOffIcon className="size-3.5 mr-2" />
            Unpin from Dock
          </ContextMenuItem>
        )}
        {onRegenerateIcon && (
          <ContextMenuItem onSelect={onRegenerateIcon}>
            <RefreshCwIcon className="size-3.5 mr-2" />
            Regenerate Icon
          </ContextMenuItem>
        )}
        {onRename && (onUnpin || onRegenerateIcon) && (
          <ContextMenuSeparator />
        )}
        {onRename && (
          <ContextMenuItem
            onSelect={() => {
              const newName = window.prompt("Rename app:", name);
              if (newName && newName.trim() && newName.trim() !== name) {
                onRename(newName.trim());
              }
            }}
          >
            <PencilIcon className="size-3.5 mr-2" />
            Rename
          </ContextMenuItem>
        )}
        {onQuit && (
          <>
            {(onUnpin || onRegenerateIcon || onRename) && <ContextMenuSeparator />}
            <ContextMenuItem
              disabled={!canQuit}
              onSelect={() => {
                if (canQuit) onQuit();
              }}
            >
              <XCircleIcon className="size-3.5 mr-2" />
              Quit
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ModeSwitcher({
  iconSize,
  tooltipSide,
}: {
  iconSize: number;
  tooltipSide: "left" | "right" | "top";
}) {
  const [open, setOpen] = useState(false);
  const mode = useDesktopMode((s) => s.mode);
  const setMode = useDesktopMode((s) => s.setMode);
  const visibleModes = useDesktopMode((s) => s.visibleModes);
  const getModeConfig = useDesktopMode((s) => s.getModeConfig);
  const modeConfig = getModeConfig(mode);
  const modes = visibleModes();
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onClickOutside);
    return () => document.removeEventListener("pointerdown", onClickOutside);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all ${
          open ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border/60"
        }`}
        style={{ width: iconSize, height: iconSize }}
        aria-label={`${modeConfig.label} mode`}
      >
        <MonitorIcon className="size-4" />
      </button>
      {open && (
        <div
          className={[
            "absolute flex flex-col min-w-[160px] py-1 rounded-lg bg-card border border-border shadow-xl z-[60]",
            tooltipSide === "right" && "left-full top-0 ml-2",
            tooltipSide === "left" && "right-full top-0 mr-2",
            tooltipSide === "top" && "bottom-full left-1/2 -translate-x-1/2 mb-2",
          ].filter(Boolean).join(" ")}
        >
          {modes.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                setMode(m.id);
                setOpen(false);
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted ${
                mode === m.id ? "text-foreground font-medium" : "text-muted-foreground"
              }`}
            >
              {mode === m.id ? (
                <CheckIcon className="size-3 shrink-0" />
              ) : (
                <span className="size-3 shrink-0" />
              )}
              <span>{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface DesktopProps {
  onOpenCommandPalette?: () => void;
  chat?: import("@/hooks/useChatState").ChatState;
}

export function Desktop({ onOpenCommandPalette, chat }: DesktopProps) {
  const windows = useWindowManager((s) => s.windows);
  const apps = useWindowManager((s) => s.apps);
  const wmCloseWindow = useWindowManager((s) => s.closeWindow);
  const wmMinimizeWindow = useWindowManager((s) => s.minimizeWindow);
  const wmRestoreAndFocusWindow = useWindowManager((s) => s.restoreAndFocusWindow);
  const wmOpenWindow = useWindowManager((s) => s.openWindow);
  const wmFocusWindow = useWindowManager((s) => s.focusWindow);
  const wmMoveWindow = useWindowManager((s) => s.moveWindow);
  const wmResizeWindow = useWindowManager((s) => s.resizeWindow);
  const wmGetWindow = useWindowManager((s) => s.getWindow);
  const wmSetApps = useWindowManager((s) => s.setApps);
  const wmSetWindows = useWindowManager((s) => s.setWindows);
  const wmLoadLayout = useWindowManager((s) => s.loadLayout);
  const wmCascadeWindows = useWindowManager((s) => s.cascadeWindows);

  const [interacting, setInteracting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [minimizingIds, setMinimizingIds] = useState<Set<string>>(new Set());
  const [showSetup, setShowSetup] = useState(false);
  const setupChecked = useRef(false);

  useEffect(() => {
    if (setupChecked.current) return;
    setupChecked.current = true;
    fetch(`${GATEWAY_URL}/api/settings/api-key/status`, {
      signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
    })
      .then((r) => r.json())
      .then((data: { hasKey: boolean }) => {
        if (!data.hasKey) setShowSetup(true);
      })
      .catch(() => setShowSetup(true));
  }, []);

  const dock = useDesktopConfigStore((s) => s.dock);
  const pinnedApps = useDesktopConfigStore((s) => s.pinnedApps) ?? [];
  const togglePin = useDesktopConfigStore((s) => s.togglePin);
  const isHorizontal = dock.position === "bottom";
  const tooltipSide: "left" | "right" | "top" = dock.position === "left" ? "right" : dock.position === "right" ? "left" : "top";
  const dockXOffset = dock.position === "left" ? dock.size + 16 : 20;

  const minimizeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const iconVersion = useId().replace(/:/g, "");

  useEffect(() => {
    const timers = minimizeTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  const animateMinimize = useCallback((id: string) => {
    if (minimizeTimers.current.has(id)) return;
    setMinimizingIds((prev) => new Set(prev).add(id));
    const timer = setTimeout(() => {
      wmMinimizeWindow(id);
      minimizeTimers.current.delete(id);
      setMinimizingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 500);
    minimizeTimers.current.set(id, timer);
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

  const generatingRef = useRef(new Set<string>());
  const checkedRef = useRef(new Set<string>());

  const checkAndGenerateIcon = useCallback((slug: string) => {
    if (checkedRef.current.has(slug) || generatingRef.current.has(slug)) return;
    checkedRef.current.add(slug);
    const iconPath = `/icons/${slug}.png`;
    fetch(`${GATEWAY_URL}${iconPath}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
    }).then((res) => {
      if (res.ok) {
        // Icon exists — update with ETag-based version if available
        const etag = res.headers.get("etag");
        if (etag) {
          const versionedUrl = versionedIconUrl(`/icons/${slug}.png`, etag);
          wmSetApps((prev) =>
            prev.map((a) =>
              nameToSlug(a.name) === slug && a.iconUrl !== versionedUrl
                ? { ...a, iconUrl: versionedUrl }
                : a,
            ),
          );
        }
      } else {
        generatingRef.current.add(slug);
        fetch(`${GATEWAY_URL}/api/apps/${slug}/icon`, {
          method: "POST",
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
        })
          .then((r) => {
            if (!r.ok) {
              r.json()
                .then((d: { error?: string }) => console.warn(`Icon gen failed for "${slug}":`, d.error))
                .catch((err) => console.warn(`[desktop] Failed to parse icon generation error for "${slug}":`, err));
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
          .catch((err) => console.warn(`Icon gen request failed for "${slug}":`, err))
          .finally(() => generatingRef.current.delete(slug));
      }
    }).catch((err) => console.warn(`[desktop] Failed to check icon for "${slug}":`, err));
  }, [wmSetApps]);

  const regenerateIcon = useCallback((slug: string) => {
    generatingRef.current.add(slug);
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
      .finally(() => generatingRef.current.delete(slug));
  }, [wmSetApps]);

  const renameAppOnServer = useCallback((slug: string, newName: string) => {
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
                    iconUrl: `/icons/${ns}.png`,
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
  }, [wmSetApps, wmSetWindows]);

  const removeFromCanvas = useCallback((appPath: string) => {
    wmSetWindows((prev) => prev.filter((w) => w.path !== appPath && !w.path.startsWith(appPath + ":")));
  }, [wmSetWindows]);

  const addApp = useCallback((name: string, path: string) => {
    const slug = nameToSlug(name);
    // Always prefer generated PNG icon over module-provided icon (which can be
    // invalid, e.g. an emoji). checkAndGenerateIcon will generate if missing.
    const optimisticUrl = `/icons/${slug}.png?v=${iconVersion}`;
    wmSetApps((prev) => {
      if (prev.find((a) => a.path === path)) return prev;
      return [...prev, { name, path, iconUrl: optimisticUrl }];
    });
    checkAndGenerateIcon(slug);
  }, [iconVersion, wmSetApps, checkAndGenerateIcon]);


  const openWindow = useCallback((name: string, path: string) => {
    // Terminal windows get unique paths to allow multiple instances
    const actualPath = path === "__terminal__"
      ? `__terminal__:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      : path;

    // Open without minimizing other windows — allow multiple apps visible
    wmOpenWindow(name, actualPath, dockXOffset);

    // In canvas mode, pan to center on the window after it opens/focuses
    if (useDesktopMode.getState().mode === "canvas") {
      requestAnimationFrame(() => {
        const win = useWindowManager.getState().windows.find((w) => w.path === actualPath);
        if (win) {
          useCanvasTransform.getState().focusOnWindow(
            win,
            window.innerWidth,
            window.innerHeight,
          );
        }
      });
    }
  }, [wmOpenWindow, dockXOffset]);

  const focusOrOpen = useCallback((name: string, path: string) => {
    const existing = useWindowManager.getState().windows.find(
      (w) => w.path === path || w.path.startsWith(path + ":"),
    );

    if (existing) {
      wmRestoreAndFocusWindow(existing.id);
    } else {
      openWindow(name, path);
    }
  }, [openWindow, wmRestoreAndFocusWindow]);

  // Vocal mode's open_app tool and auto-open-after-build both go through
  // this. Fuzzy-matches `query` against the current apps list and focuses
  // (or opens) the best match. Returns the result so the caller can
  // report success/failure back to Gemini for accurate narration.
  const openAppByName = useCallback(
    (query: string): { success: boolean; resolvedName?: string } => {
      const currentApps = useWindowManager.getState().apps;
      const match = findAppByName(currentApps, query);
      if (match) {
        focusOrOpen(match.name, match.path);
        return { success: true, resolvedName: match.name };
      }
      return { success: false };
    },
    [focusOrOpen],
  );

  const loadModules = useCallback(async () => {
    try {
      const [layoutRes, modulesRes, appsRes] = await Promise.all([
        fetch(`${GATEWAY_URL}/api/layout`, {
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
        }).catch((err) => {
          console.warn("[desktop] Failed to fetch layout:", err);
          return null;
        }),
        fetch(`${GATEWAY_URL}/files/system/modules.json`, {
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
        }).catch((err) => {
          console.warn("[desktop] Failed to fetch module registry:", err);
          return null;
        }),
        fetch(`${GATEWAY_URL}/api/apps`, {
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
        }).catch((err) => {
          console.warn("[desktop] Failed to fetch app list:", err);
          return null;
        }),
      ]);

      const savedLayout: { windows?: LayoutWindow[] } =
        layoutRes?.ok ? await layoutRes.json() : {};
      const savedWindows = savedLayout.windows ?? [];
      const layoutMap = new Map(savedWindows.map((w) => [w.path, w]));

      const layoutToLoad: LayoutWindow[] = [];

      // Register built-in apps
      addApp("Terminal", "__terminal__");
      addApp("Files", "__file-browser__");
      addApp("Chat", "__chat__");
      const savedTerminals = savedWindows.filter((w) => w.path.startsWith("__terminal__"));
      for (const saved of savedTerminals) {
        layoutToLoad.push(saved);
      }

      // Load pre-installed apps from /api/apps (apps/ directory)
      if (appsRes?.ok) {
        const appsList: { name: string; path: string; icon?: string }[] = await appsRes.json();
        for (const app of appsList) {
          // path from API is like "/files/apps/calculator/index.html"
          // strip leading "/files/" to get relative path for AppViewer
          const relativePath = app.path.replace(/^\/files\//, "");
          addApp(app.name, relativePath);

          const saved = layoutMap.get(relativePath);
          if (saved) {
            layoutToLoad.push(saved);
          }
          // Don't auto-open pre-installed apps - let users open from dock/store
        }
      }

      // Load modules from modules.json (Node/Python apps with ports)
      if (modulesRes?.ok) {
        const registry: ModuleRegistryEntry[] = await modulesRes.json();

        for (const mod of registry) {
          if (mod.status !== "active") continue;

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
              const res = await fetch(candidate, {
                signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
              });
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
              addApp(appName, path);
              const saved = layoutMap.get(path);
              if (saved) {
                layoutToLoad.push(saved);
              }
              continue;
            }

            const meta: ModuleMeta = await metaRes.json();
            const entryFile = meta.entry ?? meta.entryPoint ?? "index.html";
            path = `${relativeBasePath}/${entryFile}`;
            appName = meta.name ?? mod.name;

            addApp(appName, path);

            const saved = layoutMap.get(path);
            if (saved) {
              layoutToLoad.push(saved);
            } else {
              openWindow(appName, path);
            }
          } catch (err) {
            console.warn(`[desktop] Failed to load module "${mod.name}":`, err);
          }
        }
      }

      if (layoutToLoad.length > 0) {
        wmLoadLayout(layoutToLoad);
      }
    } catch (err) {
      console.warn("[desktop] Failed to load desktop modules:", err);
    }
  }, [addApp, openWindow, wmLoadLayout]);

  useEffect(() => {
    loadModules();
  }, [loadModules]);

  useFileWatcher(
    useCallback(
      (path: string, event: string) => {
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
          } else if (event === "add") {
            addApp(name, path);
          } else {
            // "change" on existing app -- refresh open windows, don't force-open
            addApp(name, path);
          }
        }
      },
      [loadModules, addApp, wmSetApps, wmSetWindows],
    ),
  );

  const onDragStart = useCallback(
    (id: string, e: React.PointerEvent) => {
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
    },
    [wmGetWindow, wmFocusWindow],
  );

  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { id, startX, startY, origX, origY } = dragRef.current;
    wmMoveWindow(id, origX + (e.clientX - startX), origY + (e.clientY - startY));
  }, [wmMoveWindow]);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    setInteracting(false);
  }, []);

  const onResizeStart = useCallback(
    (id: string, e: React.PointerEvent) => {
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
    },
    [wmGetWindow, wmFocusWindow],
  );

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const { id, startX, startY, origW, origH } = resizeRef.current;
    wmResizeWindow(
      id,
      Math.max(MIN_WIDTH, origW + (e.clientX - startX)),
      Math.max(MIN_HEIGHT, origH + (e.clientY - startY)),
    );
  }, [wmResizeWindow]);

  const onResizeEnd = useCallback(() => {
    resizeRef.current = null;
    setInteracting(false);
  }, []);

  const [taskBoardOpen, setTaskBoardOpen] = useState(false);

  const register = useCommandStore((s) => s.register);
  const unregister = useCommandStore((s) => s.unregister);
  const desktopMode = useDesktopMode((s) => s.mode);
  const previousMode = useDesktopMode((s) => s.previousMode);
  const setDesktopMode = useDesktopMode((s) => s.setMode);
  const visibleModes = useDesktopMode((s) => s.visibleModes);
  const getModeConfig = useDesktopMode((s) => s.getModeConfig);
  const hydrated = useDesktopMode((s) => s._hydrated);
  const modeConfig = getModeConfig(hydrated ? desktopMode : "canvas");

  // When switching from a canvas-rendering mode to a non-canvas one,
  // cascade windows to fit the viewport. Canvas positions use a wide
  // grid that extends off-screen in modes without zoom/pan. Vocal mode
  // ALSO renders the CanvasRenderer (as an overlay), so canvas↔vocal
  // transitions must NOT trigger cascading — that would reorder every
  // window in place every time the user enters voice mode.
  useEffect(() => {
    const rendersCanvas = (m: typeof desktopMode) => m === "canvas" || m === "vocal";
    if (!rendersCanvas(desktopMode) && previousMode && rendersCanvas(previousMode)) {
      wmCascadeWindows(dockXOffset, 20, 30);
    }
  }, [desktopMode, previousMode, dockXOffset, wmCascadeWindows]);

  // Delayed unmount for the vocal overlay so the exit animation has time
  // to play. `active` flips the instant desktopMode leaves "vocal" (so
  // the mic/WS shut down immediately), but the DOM lingers for ~700ms
  // after to let the fade-out finish. The setState-in-effect lint rule
  // warns about cascading renders but this is a legitimate delayed-
  // unmount primitive — effect depends on desktopMode, not on
  // vocalMounted, so there's no cascade loop.
  const [vocalMounted, setVocalMounted] = useState(desktopMode === "vocal");
  useEffect(() => {
    if (desktopMode === "vocal") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVocalMounted(true);
      return;
    }
    const t = setTimeout(() => setVocalMounted(false), 950);
    return () => clearTimeout(t);
  }, [desktopMode]);

  const modes = visibleModes();
  const cycleMode = useCallback(() => {
    const idx = modes.findIndex((m) => m.id === desktopMode);
    // If current mode is hidden or not found, jump to the first visible mode.
    const nextIdx = idx < 0 ? 0 : (idx + 1) % modes.length;
    setDesktopMode(modes[nextIdx].id);
  }, [modes, desktopMode, setDesktopMode]);

  const toggleMcRef = useRef(() => { setTaskBoardOpen((prev) => !prev); setSettingsOpen(false); });
  const openWindowRef = useRef(openWindow);
  useEffect(() => {
    openWindowRef.current = openWindow;
  }, [openWindow]);

  useEffect(() => {
    const modeCommands = visibleModes().map((m) => ({
      id: `mode:${m.id}`,
      label: `Mode: ${m.label}`,
      group: "Actions" as const,
      keywords: ["mode", "layout", m.id, m.description],
      execute: () => setDesktopMode(m.id),
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
          const el = document.querySelector(`[data-window-id="${focused.id}"]`) as HTMLElement | null;
          if (el) el.requestFullscreen?.();
        },
      },
    ]);
    return () => unregister([
      "action:toggle-mc",
      "action:open-settings",
      "action:open-file-browser",
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
  }, [register, unregister, visibleModes, setDesktopMode, openWindow, animateMinimize, wmCloseWindow]);

  useEffect(() => {
    const appCommands = apps.map((app) => ({
      id: `app:${app.path}`,
      label: app.name,
      group: "Apps" as const,
      icon: app.iconUrl,
      keywords: [app.path],
      execute: () => openWindowRef.current(app.name, app.path),
    }));
    if (appCommands.length > 0) register(appCommands);
    return () => unregister(apps.map((a) => `app:${a.path}`));
  }, [apps, register, unregister]);

  return (
    <TooltipProvider delayDuration={300}>
      {!showSetup && (
        <MenuBar onOpenCommandPalette={onOpenCommandPalette ?? (() => {})} onNewWindow={() => openWindow("Terminal", "__terminal__")} onMinimizeWindow={animateMinimize}>
          {desktopMode === "canvas" && <CanvasToolbar />}
        </MenuBar>
      )}
      {showSetup && (
        <OnboardingScreen
          onComplete={() => {
            // Whether the user finished onboarding or skipped it, land them
            // on the moraine-lake wallpaper. Best-effort persist to the
            // gateway; the local default already matches so the visual is
            // correct even if the gateway is unreachable.
            saveDesktopConfig({
              background: { type: "wallpaper", name: "moraine-lake.jpg" },
              dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
              pinnedApps: [],
            }).catch(() => {});
            setShowSetup(false);
          }}
          onOpenTerminal={() => openWindow("Terminal", "__terminal__")}
        />
      )}
      <div className="relative flex-1 flex flex-col md:flex-row md:pt-7">
        {/* Desktop dock -- hidden in ambient/conversational modes and during setup */}
        {modeConfig.showDock && !showSetup && <div
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
          {/* Center section: app icons */}
          <div className={isHorizontal
            ? "flex flex-row items-center justify-center gap-1"
            : "flex flex-col items-center justify-center gap-1"
          }>
            {(() => {
              const pinnedSet = new Set(pinnedApps);
              const visibleWindowPaths = windows.filter((w) => !w.minimized).map((w) => w.path);
              const hasVisibleWindow = (appPath: string) =>
                visibleWindowPaths.some((wp) => wp === appPath || wp.startsWith(appPath + ":"));
              const pinnedList = apps.filter((a) => pinnedSet.has(a.path));
              const openUnpinned = apps.filter((a) => !pinnedSet.has(a.path) && hasVisibleWindow(a.path));
              const allDockApps = [...pinnedList, ...openUnpinned];

              return allDockApps.length > 0 ? (
                <>
                  {pinnedList.map((app) => {
                    const hasAny = hasVisibleWindow(app.path);
                    return (
                      <DockIcon
                        key={app.path}
                        name={app.name}
                        active={hasAny}
                        onClick={() => focusOrOpen(app.name, app.path)}
                        iconSize={dock.iconSize}
                        tooltipSide={tooltipSide}
                        iconUrl={app.iconUrl}
                        onUnpin={() => togglePin(app.path)}
                        onRegenerateIcon={() => regenerateIcon(nameToSlug(app.name))}
                        onRename={(newName) => renameAppOnServer(nameToSlug(app.name), newName)}
                        onQuit={() => removeFromCanvas(app.path)}
                        canQuit={hasAny}
                      />
                    );
                  })}
                  {pinnedList.length > 0 && openUnpinned.length > 0 && (
                    <div className={isHorizontal ? "h-6 border-l border-border/40" : "w-6 border-t border-border/40"} />
                  )}
                  {openUnpinned.map((app) => (
                    <DockIcon
                      key={app.path}
                      name={app.name}
                      active
                      onClick={() => focusOrOpen(app.name, app.path)}
                      iconSize={dock.iconSize}
                      tooltipSide={tooltipSide}
                      iconUrl={app.iconUrl}
                      onRegenerateIcon={() => regenerateIcon(nameToSlug(app.name))}
                      onRename={(newName) => renameAppOnServer(nameToSlug(app.name), newName)}
                      onQuit={() => removeFromCanvas(app.path)}
                      canQuit
                    />
                  ))}
                </>
              ) : null;
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
                <>
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
                        }}
                        iconSize={Math.round(dock.iconSize * 0.8)}
                        tooltipSide={tooltipSide}
                        iconUrl={getIconForWindow(win.path)}
                      />
                    </div>
                  ))}
                </>
              );
            })()}
          </div>

          {/* Bottom cluster: launcher + mode switcher + settings, grouped
              together so all system controls sit below the app icons. */}
          <div className={isHorizontal
            ? "flex flex-row items-center gap-1"
            : "flex flex-col items-center gap-1"
          }>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="dock-tasks"
                  onClick={() => { setTaskBoardOpen((prev) => !prev); setSettingsOpen(false); }}
                  className={`flex items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all ${
                    taskBoardOpen
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card border-border/60"
                  }`}
                  style={{ width: dock.iconSize, height: dock.iconSize }}
                >
                  <KanbanSquareIcon className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side={tooltipSide} sideOffset={8}>
                Launcher
              </TooltipContent>
            </Tooltip>
            <ModeSwitcher iconSize={dock.iconSize} tooltipSide={tooltipSide} />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="dock-settings"
                  onClick={() => { setSettingsOpen((prev) => !prev); setTaskBoardOpen(false); }}
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
          <div
            className={
              isHorizontal
                ? "absolute left-full top-1/2 -translate-y-1/2 ml-2 pointer-events-auto"
                : "absolute top-full left-1/2 -translate-x-1/2 mt-2 pointer-events-auto"
            }
          >
            <ConnectionIndicator />
          </div>
        </aside>
        </div>}

        {/* Mobile dock (bottom tab bar) */}
        {modeConfig.showDock && (
          <nav className="flex md:hidden items-center gap-1 px-2 py-1.5 border-t border-border/40 bg-card/80 backdrop-blur-sm order-last overflow-x-auto z-[55]">
            <button
              onClick={() => { setTaskBoardOpen((prev) => !prev); setSettingsOpen(false); }}
              className={`flex shrink-0 size-9 items-center justify-center rounded-lg border transition-all active:scale-95 ${
                taskBoardOpen
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border/60"
              }`}
            >
              <KanbanSquareIcon className="size-4" />
            </button>
            <ModeSwitcher iconSize={36} tooltipSide="top" />
            <button
              onClick={() => { setSettingsOpen((prev) => !prev); setTaskBoardOpen(false); }}
              className={`flex shrink-0 size-9 items-center justify-center rounded-lg border transition-all active:scale-95 ${
                settingsOpen
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border/60"
              }`}
              title="Settings"
            >
              <SettingsIcon className="size-4" />
            </button>
            <div className="shrink-0">
              <UserButton />
            </div>
            {apps.filter((a) => pinnedApps.includes(a.path)).map((app) => {
              const win = windows.find(
                (w) => w.path === app.path && !w.minimized,
              );
              return (
                <button
                  key={app.path}
                  onClick={() => openWindow(app.name, app.path)}
                  className={`flex shrink-0 h-9 items-center gap-1.5 px-3 rounded-lg border transition-all active:scale-95 ${
                    win
                      ? "bg-primary/10 border-primary/30 text-foreground"
                      : "bg-card border-border/60 text-muted-foreground"
                  }`}
                >
                  <span className="text-xs font-medium truncate max-w-[80px]">{app.name}</span>
                </button>
              );
            })}
          </nav>
        )}

        <div className="relative flex-1 min-h-0 overflow-hidden">
          <DotGrid />
          <MissionControl
            open={taskBoardOpen}
            apps={apps}
            openWindows={new Set(windows.filter((w) => !w.minimized).map((w) => w.path))}
            onOpenApp={openWindow}
            onClose={() => setTaskBoardOpen(false)}
            pinnedApps={pinnedApps}
            onTogglePin={togglePin}
            onRegenerateIcon={regenerateIcon}
            onRenameApp={renameAppOnServer}
            onRemoveFromCanvas={removeFromCanvas}
          />

          {!modeConfig.showWindows && modeConfig.id === "ambient" && (
            <AmbientClock onSwitchMode={cycleMode} />
          )}

          {!modeConfig.showWindows && modeConfig.id !== "ambient" && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <p className="text-sm text-muted-foreground mb-1">
                  {modeConfig.label} mode
                </p>
                <button
                  onClick={cycleMode}
                  className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                >
                  Switch mode
                </button>
              </div>
            </div>
          )}

          {modeConfig.showWindows &&
            (desktopMode === "canvas" || desktopMode === "vocal") &&
            !showSetup && <CanvasRenderer />}

          {vocalMounted && !showSetup && (
            <VocalPanel
              active={desktopMode === "vocal"}
              chat={chat}
              onOpenApp={openAppByName}
            />
          )}

          {modeConfig.showWindows && desktopMode !== "canvas" && desktopMode !== "vocal" && windows.filter((w) => !w.minimized).length === 0 &&
            apps.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-white/50 drop-shadow-md">
                  No apps running. Try &quot;Build me a notes app&quot; in
                  the chat.
                </p>
              </div>
            )}

          {/* Desktop: positioned windows; Mobile: full-screen cards */}
          {modeConfig.showWindows && desktopMode !== "canvas" && desktopMode !== "vocal" && windows.map((win) => {
            const isMinimizing = minimizingIds.has(win.id);
            if (win.minimized && !isMinimizing) return null;

            // Compute dock target for suck animation
            let dockTargetX = 0;
            let dockTargetY = 0;
            if (isMinimizing) {
              const winCenterX = win.x + win.width / 2;
              const winCenterY = win.y + win.height / 2;
              if (dock.position === "left") {
                dockTargetX = -winCenterX;
                dockTargetY = (window.innerHeight / 2) - winCenterY;
              } else if (dock.position === "right") {
                dockTargetX = window.innerWidth - winCenterX;
                dockTargetY = (window.innerHeight / 2) - winCenterY;
              } else {
                dockTargetX = (window.innerWidth / 2) - winCenterX;
                dockTargetY = window.innerHeight - winCenterY;
              }
            }

            return (
              <Card
                key={win.id}
                data-window-id={win.id}
                className="app-window absolute gap-0 rounded-none md:rounded-lg p-0 overflow-hidden shadow-2xl"
                style={{
                  "--win-x": `${win.x}px`,
                  "--win-y": `${win.y}px`,
                  "--win-w": `${win.width}px`,
                  "--win-h": `${win.height}px`,
                  zIndex: win.zIndex,
                  transformOrigin: isMinimizing
                    ? dock.position === "left" ? "left center"
                    : dock.position === "right" ? "right center"
                    : "center bottom"
                    : undefined,
                  transition: isMinimizing
                    ? "transform 500ms cubic-bezier(0.5, 0, 0.7, 0.4), opacity 400ms cubic-bezier(0.4, 0, 1, 1), filter 500ms ease-out"
                    : undefined,
                  transform: isMinimizing
                    ? `translate(${dockTargetX}px, ${dockTargetY}px) scale(0.03) rotate(${dock.position === "bottom" ? "2deg" : "0deg"})`
                    : undefined,
                  opacity: isMinimizing ? 0 : undefined,
                  filter: isMinimizing ? "blur(2px)" : undefined,
                  pointerEvents: isMinimizing ? "none" : undefined,
                } as React.CSSProperties}
                onMouseDown={() => wmFocusWindow(win.id)}
              >
                <CardHeader
                  className="flex flex-row items-center gap-0 px-3 py-2 border-b border-border md:cursor-grab md:active:cursor-grabbing select-none space-y-0"
                  onPointerDown={(e) => onDragStart(win.id, e)}
                  onPointerMove={onDragMove}
                  onPointerUp={onDragEnd}
                >
                  <TrafficLights
                    onClose={() => wmCloseWindow(win.id)}
                    onMinimize={() => animateMinimize(win.id)}
                  />
                  <CardTitle className="text-xs font-medium truncate flex-1 text-center">
                    {win.title}
                  </CardTitle>
                  <div className="w-[54px] flex items-center justify-end">
                    <AIButton
                      appName={win.title}
                      appPath={win.path}
                    />
                  </div>
                </CardHeader>

                <CardContent className="relative flex-1 p-0 min-h-0">
                  {win.path.startsWith("__terminal__") ? (
                    <TerminalApp />
                  ) : win.path === "__file-browser__" ? (
                    <FileBrowser windowId={win.id} />
                  ) : win.path === "__preview-window__" ? (
                    <PreviewWindow />
                  ) : win.path === "__chat__" ? (
                    <div className="h-full overflow-hidden">
                      {chat && (
                        <ChatApp
                          messages={chat.messages}
                          sessionId={chat.sessionId}
                          busy={chat.busy}
                          connected={chat.connected}
                          conversations={chat.conversations}
                          onNewChat={chat.newChat}
                          onSwitchConversation={chat.switchConversation}
                          onSubmit={chat.submitMessage}
                        />
                      )}
                    </div>
                  ) : (
                    <AppViewer path={win.path} onOpenApp={openWindow} />
                  )}
                  {interacting && (
                    <div className="absolute inset-0 z-10" />
                  )}
                </CardContent>

                <div
                  className="hidden md:block absolute bottom-0 right-0 size-4 cursor-se-resize touch-none z-20"
                  onPointerDown={(e) => onResizeStart(win.id, e)}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeEnd}
                >
                  <svg
                    viewBox="0 0 16 16"
                    className="size-4 text-muted-foreground/40"
                  >
                    <path
                      d="M14 2v12H2"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                    <path
                      d="M14 7v7H7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                  </svg>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      <Settings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </TooltipProvider>
  );
}
