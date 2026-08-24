import { useEffect, useEffectEvent } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import AppLauncher from "../embeds/AppLauncher";

export default function DesktopLaunchpad({
  open,
  onClose,
  onLaunchTab,
}: {
  open: boolean;
  onClose: () => void;
  onLaunchTab?: (tabId: string) => void;
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
      className={`absolute inset-0 min-h-0 flex-col backdrop-blur-xl ${open ? "flex" : "hidden"}`}
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
        onLaunch={(tabId) => {
          onLaunchTab?.(tabId);
          onClose();
        }}
      />
    </dialog>
  );
}
