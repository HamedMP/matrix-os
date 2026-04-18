"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { Reorder } from "framer-motion";
import { useTaskBoard } from "@/hooks/useTaskBoard";
import { nameToSlug } from "@/lib/utils";
import { isSystemApp, applyOrder } from "@/lib/dock-sections";
import { useDesktopConfigStore } from "@/stores/desktop-config";
import { useWindowManager } from "@/hooks/useWindowManager";
import { AppTile } from "./AppTile";
import {
  XIcon,
  Loader2Icon,
  CheckCircle2Icon,
} from "lucide-react";

interface AppEntry {
  name: string;
  path: string;
  iconUrl?: string;
}

interface MissionControlProps {
  open: boolean;
  apps: AppEntry[];
  openWindows: Set<string>;
  onOpenApp: (name: string, path: string) => void;
  onClose: () => void;
  pinnedApps: string[];
  onTogglePin: (path: string) => void;
  onRegenerateIcon: (slug: string) => void;
  onRenameApp?: (slug: string, newName: string) => void;
  onRemoveFromCanvas?: (path: string) => void;
}

export function MissionControl({
  open,
  apps,
  openWindows,
  onOpenApp,
  onClose,
  pinnedApps,
  onTogglePin,
  onRegenerateIcon,
  onRenameApp,
  onRemoveFromCanvas,
}: MissionControlProps) {
  const { provision } = useTaskBoard();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const closingRef = useRef(false);

  const prevOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      closingRef.current = false;
      setMounted(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    } else if (!open && wasOpen) {
      closingRef.current = true;
      setVisible(false);
      const timer = setTimeout(() => {
        setMounted(false);
        closingRef.current = false;
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mounted, onClose]);

  if (!mounted) return null;

  return (
    <div data-mission-control className="fixed inset-0 z-[45]">
      <div
        data-mission-backdrop
        className="absolute inset-0 bg-black/30 transition-all duration-300 ease-out"
        style={{
          backdropFilter: visible ? "blur(24px)" : "blur(0px)",
          opacity: visible ? 1 : 0,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />

      <div
        className="relative flex flex-col h-full z-10 overflow-hidden md:pl-14 pt-16 transition-all duration-300 ease-out"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "scale(1) translateY(0)" : "scale(0.97) translateY(12px)",
        }}
      >
        <div className="flex items-center justify-between px-6 py-4">
          <h2 className="text-lg font-semibold text-white">Launcher</h2>
          <button
            onClick={onClose}
            className="size-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {provision.active && (
          <div className="flex items-center gap-2 mx-6 mb-3 px-3 py-1.5 rounded-lg bg-muted/50 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            <span>Building {provision.total} apps...</span>
          </div>
        )}
        {!provision.active && provision.total > 0 && (
          <div className="flex items-center gap-2 mx-6 mb-3 px-3 py-1.5 rounded-lg bg-muted/50 text-xs text-muted-foreground">
            <CheckCircle2Icon className="size-3" />
            <span>
              {provision.succeeded}/{provision.total} apps built
              {provision.failed > 0 && ` (${provision.failed} failed)`}
            </span>
          </div>
        )}

        <LauncherGrid
          apps={apps}
          openWindows={openWindows}
          pinnedApps={pinnedApps}
          onOpenApp={onOpenApp}
          onClose={onClose}
          onTogglePin={onTogglePin}
          onRegenerateIcon={onRegenerateIcon}
          onRenameApp={onRenameApp}
          onRemoveFromCanvas={onRemoveFromCanvas}
          visible={visible}
          closingRef={closingRef}
        />
      </div>
    </div>
  );
}

/**
 * Splits the app grid into two sections separated by a hairline divider:
 * "Main" (system apps -- Terminal, Files, Chat, Preview, etc) on top, and
 * "Generated" (everything the agent has built) below. The animation
 * stagger continues across both sections so the reveal still feels like
 * one orchestrated moment.
 */
function LauncherGrid({
  apps,
  openWindows,
  pinnedApps,
  onOpenApp,
  onClose,
  onTogglePin,
  onRegenerateIcon,
  onRenameApp,
  onRemoveFromCanvas,
  visible,
  closingRef,
}: {
  apps: AppEntry[];
  openWindows: Set<string>;
  pinnedApps: string[];
  onOpenApp: (name: string, path: string) => void;
  onClose: () => void;
  onTogglePin: (path: string) => void;
  onRegenerateIcon: (slug: string) => void;
  onRenameApp?: (slug: string, newName: string) => void;
  onRemoveFromCanvas?: (path: string) => void;
  visible: boolean;
  closingRef: React.RefObject<boolean>;
}) {
  // Share the dock's ordering: reordering in the launcher persists into
  // the same dockOrder, so a user's preferred order shows up on both
  // surfaces. Pinned/open subset on the dock is computed from this same
  // source list, so the relative order matches.
  const dockOrder = useDesktopConfigStore((s) => s.dockOrder);
  const reorderDockSection = useDesktopConfigStore((s) => s.reorderDockSection);
  const appLaunchTimes = useWindowManager((s) => s.appLaunchTimes);

  const { mainApps, generatedApps } = useMemo(() => {
    const main: AppEntry[] = [];
    const gen: AppEntry[] = [];
    for (const app of apps) {
      if (isSystemApp(app.path)) main.push(app);
      else gen.push(app);
    }
    return {
      mainApps: applyOrder(main, dockOrder?.systemApps, appLaunchTimes),
      generatedApps: applyOrder(gen, dockOrder?.userApps, appLaunchTimes),
    };
  }, [apps, dockOrder, appLaunchTimes]);

  const renderTile = (app: AppEntry, indexInAll: number) => {
    const slug = nameToSlug(app.name);
    return (
      <Reorder.Item
        key={app.path}
        value={app.path}
        as="div"
        // touch-none keeps touch drags from scrolling the launcher
        // mid-reorder. cursor-grab signals the affordance.
        className="cursor-grab touch-none active:cursor-grabbing"
        // macOS-Dock-style lift: scale + shadow so the dragged tile
        // visually detaches from the grid while siblings slide aside.
        whileDrag={{
          scale: 1.12,
          zIndex: 50,
          boxShadow: "0 16px 40px -8px rgba(0,0,0,0.5)",
        }}
        transition={{ type: "spring", stiffness: 600, damping: 38 }}
        // Entrance stagger -- delay per index across both sections so
        // the launcher reveal still feels like one orchestrated moment.
        // We disable the stagger on close so dismissal feels instant.
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0)" : "translateY(16px)",
          transition: "opacity 300ms ease-out, transform 300ms ease-out",
          transitionDelay: closingRef.current ? "0ms" : `${50 + indexInAll * 20}ms`,
        }}
      >
        <AppTile
          name={app.name}
          isOpen={openWindows.has(app.path)}
          onClick={() => {
            onOpenApp(app.name, app.path);
            onClose();
          }}
          pinned={pinnedApps.includes(app.path)}
          onTogglePin={() => onTogglePin(app.path)}
          iconUrl={app.iconUrl}
          onRegenerateIcon={() => onRegenerateIcon(slug)}
          onRename={onRenameApp ? (newName) => onRenameApp(slug, newName) : undefined}
          onRemoveFromCanvas={onRemoveFromCanvas ? () => onRemoveFromCanvas(app.path) : undefined}
        />
      </Reorder.Item>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto px-6 pb-6">
      {mainApps.length > 0 && (
        <>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">
            Main
          </div>
          <Reorder.Group
            as="div"
            axis="x"
            values={mainApps.map((a) => a.path)}
            onReorder={(order) => reorderDockSection("systemApps", order)}
            className="flex flex-wrap gap-1 justify-start"
          >
            {mainApps.map((app, i) => renderTile(app, i))}
          </Reorder.Group>
        </>
      )}

      {mainApps.length > 0 && generatedApps.length > 0 && (
        <div
          className="my-5 h-px w-full bg-white/15"
          aria-hidden
          style={{
            opacity: visible ? 1 : 0,
            transition: "opacity 300ms ease-out",
            transitionDelay: closingRef.current ? "0ms" : `${50 + mainApps.length * 20}ms`,
          }}
        />
      )}

      {generatedApps.length > 0 && (
        <>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">
            My Apps
          </div>
          <Reorder.Group
            as="div"
            axis="x"
            values={generatedApps.map((a) => a.path)}
            onReorder={(order) => reorderDockSection("userApps", order)}
            className="flex flex-wrap gap-1 justify-start"
          >
            {generatedApps.map((app, i) => renderTile(app, mainApps.length + i))}
          </Reorder.Group>
        </>
      )}
    </div>
  );
}
