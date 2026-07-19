"use client";

import { useEffect, useEffectEvent, useState, useRef } from "react";
import { useTaskBoard } from "@/hooks/useTaskBoard";
import { nameToSlug } from "@/lib/utils";
import { groupLauncherApps } from "@/lib/dock-sections";
import { useDesktopConfigStore } from "@/stores/desktop-config";
import { useWindowManager } from "@/hooks/useWindowManager";
import { AppTile } from "./AppTile";
import { useThemeStyle } from "./window/useThemeStyle";
import { Launchpad } from "./launchpad/Launchpad";
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
  const themeStyle = useThemeStyle();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const closingRef = useRef(false);

  const prevOpenRef = useRef(open);
  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- enter/exit animation orchestration, not derived state: the `open` prop drives requestAnimationFrame double-buffering (mount now, set visible next frame) and a 300ms setTimeout-delayed unmount. These are side effects that must run in an effect, and `mounted`/`visible` cannot be computed in render without dropping the transition.
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      closingRef.current = false;
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- mount immediately on the open rising edge, then setVisible on the next frame (rAF double-buffer); deriving in render would skip the enter transition.
      setMounted(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    } else if (!open && wasOpen) {
      closingRef.current = true;
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- start the exit transition now, then unmount after the 300ms setTimeout below; deriving in render would unmount instantly and skip the exit animation.
      setVisible(false);
      const timer = setTimeout(() => {
        setMounted(false);
        closingRef.current = false;
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const onCloseEvent = useEffectEvent(() => onClose());

  useEffect(() => {
    if (!mounted) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseEvent();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mounted]);

  if (!mounted) return null;

  // macOS design: the launcher is a full-screen Launchpad take-over instead
  // of the classic panel. Mount/visible timing and the global Escape handler
  // above stay shared, so open/close behavior is identical across variants.
  if (themeStyle === "macos-glass") {
    return (
      <Launchpad apps={apps} visible={visible} onOpenApp={onOpenApp} onClose={onClose} />
    );
  }

  return (
    <div data-mission-control className="fixed inset-0 z-[45]">
      {/* react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions -- light-dismiss backdrop: a pure pointer convenience that closes the launcher only when the empty area itself is clicked. Keyboard dismiss is already provided by the global Escape handler above, and the launcher's real controls are focusable buttons. */}
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

      {/* react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions -- light-dismiss surface: closes the launcher only when this empty wrapper itself (not its children) is clicked. Keyboard dismiss is handled by the global Escape handler above. */}
      <div
        className="relative flex flex-col h-full z-10 overflow-hidden md:pl-14 pt-16 transition-all duration-300 ease-out"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "scale(1) translateY(0)" : "scale(0.97) translateY(12px)",
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="flex items-center justify-between px-6 py-4">
          <h2 className="text-lg font-semibold text-white">Launcher</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close launcher"
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
  // Share the dock's ordering so launcher and dock display in the same order.
  // Reorder itself happens only in the dock (single-row, Reorder math stable).
  const dockOrder = useDesktopConfigStore((s) => s.dockOrder);
  const appLaunchTimes = useWindowManager((s) => s.appLaunchTimes);

  const { mainApps, generatedApps, gameApps } = groupLauncherApps(apps, dockOrder, appLaunchTimes);

  // Launcher is an overview — dock (Desktop.tsx) is the reorder surface, which
  // uses a single-row flex layout where framer-motion Reorder's axis math works.
  // A wrapped grid + Reorder.Group miscomputes neighbor indices across rows, so
  // tiles here are plain divs.
  const renderTile = (app: AppEntry, indexInAll: number) => {
    const slug = nameToSlug(app.name);
    return (
      <div
        key={app.path}
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
      </div>
    );
  };

  return (
    // react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions -- light-dismiss surface: closes the launcher only when this empty scroll area itself (not the app tiles) is clicked. Keyboard dismiss is handled by the launcher's global Escape handler.
    <div
      className="flex-1 overflow-y-auto px-6 pb-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {mainApps.length > 0 && (
        <>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">
            Main
          </div>
          {/* react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions -- light-dismiss surface: closes the launcher only when the empty grid gap (not an app tile) is clicked. Keyboard dismiss is handled by the launcher's global Escape handler. */}
          <div
            className="flex flex-wrap gap-1 justify-start"
            onClick={(e) => {
              if (e.target === e.currentTarget) onClose();
            }}
          >
            {/* react-doctor-disable-next-line react-hooks-js/refs -- closingRef is an intentional non-reactive latch read during render for the stagger timing: it must NOT trigger a re-render when toggled, but its current value selects the per-tile transitionDelay at render time. */}
            {mainApps.map((app, i) => renderTile(app, i))}
          </div>
        </>
      )}

      {mainApps.length > 0 && generatedApps.length > 0 && (
        <div
          className="my-5 h-px w-full bg-white/15"
          aria-hidden
          style={{
            opacity: visible ? 1 : 0,
            transition: "opacity 300ms ease-out",
            // react-doctor-disable-next-line react-hooks-js/refs -- closingRef is an intentional non-reactive latch read during render: toggling it must not re-render, but its current value selects the divider's transitionDelay at render time.
            transitionDelay: closingRef.current ? "0ms" : `${50 + mainApps.length * 20}ms`,
          }}
        />
      )}

      {generatedApps.length > 0 && (
        <>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">
            My Apps
          </div>
          {/* react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions -- light-dismiss surface: closes the launcher only when the empty grid gap (not an app tile) is clicked. Keyboard dismiss is handled by the launcher's global Escape handler. */}
          <div
            className="flex flex-wrap gap-1 justify-start"
            onClick={(e) => {
              if (e.target === e.currentTarget) onClose();
            }}
          >
            {/* react-doctor-disable-next-line react-hooks-js/refs -- closingRef is an intentional non-reactive latch read during render for the stagger timing: it must NOT trigger a re-render when toggled, but its current value selects the per-tile transitionDelay at render time. */}
            {generatedApps.map((app, i) => renderTile(app, mainApps.length + i))}
          </div>
        </>
      )}

      {gameApps.length > 0 && (mainApps.length > 0 || generatedApps.length > 0) && (
        <div
          className="my-5 h-px w-full bg-white/15"
          aria-hidden
          style={{
            opacity: visible ? 1 : 0,
            transition: "opacity 300ms ease-out",
            // react-doctor-disable-next-line react-hooks-js/refs -- closingRef is a non-reactive stagger latch read at render time; toggling it must not re-render.
            transitionDelay: closingRef.current ? "0ms" : `${50 + (mainApps.length + generatedApps.length) * 20}ms`,
          }}
        />
      )}

      {gameApps.length > 0 && (
        <>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">
            Games
          </div>
          {/* react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions -- light-dismiss surface: closes the launcher only when the empty grid gap (not an app tile) is clicked. Keyboard dismiss is handled by the launcher's global Escape handler. */}
          <div
            className="flex flex-wrap gap-1 justify-start"
            onClick={(e) => {
              if (e.target === e.currentTarget) onClose();
            }}
          >
            {/* react-doctor-disable-next-line react-hooks-js/refs -- closingRef is an intentional non-reactive latch read during render for the stagger timing. */}
            {gameApps.map((app, i) => renderTile(app, mainApps.length + generatedApps.length + i))}
          </div>
        </>
      )}
    </div>
  );
}
