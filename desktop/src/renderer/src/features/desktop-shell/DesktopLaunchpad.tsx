import { useEffect } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import AppLauncher from "../embeds/AppLauncher";

export default function DesktopLaunchpad({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <section
      role="dialog"
      aria-label="App launcher"
      data-testid="app-launcher-backdrop"
      className="absolute inset-0 flex min-h-0 flex-col backdrop-blur-xl"
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
      <AppLauncher presentation="launchpad" onLaunch={onClose} />
    </section>
  );
}
