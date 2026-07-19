"use client";

import { useEffect } from "react";
import { useOsSessionStore } from "./os-session-store";
import { BOOT_BEAT_MS } from "./os-session-utils";
import { OsBootScreen } from "./OsBootScreen";
import {
  XpLogoffDialog,
  XpSafeOffScreen,
  XpShutdownDialog,
  XpWelcomeScreen,
} from "./XpSessionOverlays";
import { Win11LockScreen } from "./Win11LockScreen";
import { MacLockScreen } from "./MacLockScreen";
import "./os-session.css";

/**
 * Hosts the OS session overlays (Feature: lock / user-switch / log-off
 * simulation) and explicit design-switch boot beats. Rendered once by Desktop.
 * Theme hydration can run whenever Settings mounts, so attribute mutations are
 * deliberately not interpreted as boots; DesignPicker starts the beat only for
 * a user-initiated OS switch.
 */
export function OsSessionHost() {
  const view = useOsSessionStore((s) => s.view);
  const bootDesign = useOsSessionStore((s) => s.bootDesign);
  const bootId = useOsSessionStore((s) => s.bootId);

  // Auto-dismiss the boot beat. `bootId` retriggers the window when beats
  // happen back to back.
  useEffect(() => {
    if (!bootDesign) return;
    const timer = setTimeout(() => useOsSessionStore.getState().endBoot(), BOOT_BEAT_MS);
    return () => clearTimeout(timer);
  }, [bootDesign, bootId]);

  // Body scroll lock while any full-screen overlay is up. The shell root is
  // already overflow-hidden; this is the guard for embedded/mobile contexts.
  const overlayOpen = view !== "none" || bootDesign !== null;
  useEffect(() => {
    if (!overlayOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [overlayOpen]);

  // Escape dismisses the dialog-style XP overlays (Win11/macOS lock screens
  // use their OS-authentic dismissals instead: any key / password Enter).
  useEffect(() => {
    if (view !== "xp-logoff" && view !== "xp-shutdown" && view !== "xp-welcome") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") useOsSessionStore.getState().close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view]);

  return (
    <>
      {bootDesign ? <OsBootScreen design={bootDesign} /> : null}
      {view === "xp-logoff" ? <XpLogoffDialog /> : null}
      {view === "xp-shutdown" ? <XpShutdownDialog /> : null}
      {view === "xp-welcome" ? <XpWelcomeScreen /> : null}
      {view === "xp-safe-off" ? <XpSafeOffScreen /> : null}
      {view === "win11-lock" ? <Win11LockScreen /> : null}
      {view === "macos-lock" ? <MacLockScreen /> : null}
    </>
  );
}
