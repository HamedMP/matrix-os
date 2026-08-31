import { useEffect, useEffectEvent } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import AppLauncher from "../embeds/AppLauncher";
import type { DesktopAppConfig } from "./desktop-apps";
import type { OsViewMode } from "@matrix-os/contracts";

export default function DesktopLaunchpad({
  open,
  onClose,
  onLaunchTab,
  onCreateApp,
  onOpenDesktopApp,
  onAddToDesktop,
  osViewMode,
  onSwitchOsView,
}: {
  open: boolean;
  onClose: () => void;
  onLaunchTab?: (tabId: string) => void;
  onCreateApp?: () => void;
  onOpenDesktopApp?: (app: DesktopAppConfig) => void;
  onAddToDesktop?: (path: string) => void;
  osViewMode: OsViewMode;
  onSwitchOsView: (mode: OsViewMode) => void;
}) {
  const closeLauncher = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeLauncher();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <dialog
      open={open}
      aria-label="App launcher"
      aria-hidden={!open}
      inert={!open}
      data-testid="app-launcher-backdrop"
      className={`absolute inset-0 m-0 h-full min-h-0 w-full max-h-none max-w-none flex-col border-0 p-0 backdrop-blur-xl ${open ? "flex" : "hidden"}`}
      style={{
        zIndex: DESKTOP_Z_INDEX.nativeDesktopLaunchpad,
        background: "color-mix(in srgb, var(--bg-app) 34%, transparent)",
      }}
      onPointerDown={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("[data-launchpad-interactive]")) return;
        onClose();
      }}
    >
      <AppLauncher
        presentation="launchpad"
        launcherActive={open}
        onCreateApp={onCreateApp}
        onOpenDesktopApp={onOpenDesktopApp}
        onAddToDesktop={onAddToDesktop}
        osViewMode={osViewMode}
        onSwitchOsView={(mode) => {
          onSwitchOsView(mode);
          onClose();
        }}
        onLaunch={(tabId) => {
          onLaunchTab?.(tabId);
          onClose();
        }}
      />
    </dialog>
  );
}
