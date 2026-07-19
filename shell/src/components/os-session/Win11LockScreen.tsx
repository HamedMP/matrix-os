"use client";

import { useEffect, useState } from "react";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { useIsClient } from "@/hooks/useIsClient";
import { StartMenuUser } from "../taskbar/taskbar-shared";
import { useOsSessionStore } from "./os-session-store";

function formatLockTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatLockDate(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** SSR-safe big lock-screen clock (same tick pattern as TaskbarClock). */
function Win11LockClock() {
  const isClient = useIsClient();
  const [tick, setTick] = useState(0);
  const now = isClient ? new Date() : null;

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- setTick only fires from the setTimeout callback (never a synchronous cascade); depending on [tick] re-arms the timeout to the upcoming minute boundary after each update, so a single timer is enough — a parallel interval would double-fire on the boundary.
  useEffect(() => {
    if (!isClient) return;
    const stamp = new Date();
    const ms = (60 - stamp.getSeconds()) * 1000 - stamp.getMilliseconds();
    const timeout = setTimeout(() => setTick((t) => t + 1), ms);
    return () => clearTimeout(timeout);
  }, [isClient, tick]);

  return (
    <div className="os-win11-lock-clock">
      <span className="os-win11-lock-time tabular-nums">{now ? formatLockTime(now) : " "}</span>
      <span className="os-win11-lock-date">{now ? formatLockDate(now) : " "}</span>
    </div>
  );
}

/**
 * Windows 11 lock screen (simulation): heavily blurred bloom-wallpaper
 * backdrop (the wallpaper lives on <body>, so a translucent backdrop-filter
 * layer reproduces the lock-screen blur), a large clock + date, then — after
 * a click or any key — the user tile that signs back in to the desktop.
 */
export function Win11LockScreen() {
  const close = useOsSessionStore((s) => s.close);
  const [phase, setPhase] = useState<"clock" | "signin">("clock");

  useEffect(() => {
    if (phase !== "clock") return;
    const onKey = () => setPhase("signin");
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase]);

  return (
    // Full-screen surface: a click anywhere raises the sign-in pane, matching
    // the real Win11 lock screen. The inner tile is the only "button".
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- keyboard parity is the document keydown listener above (any key raises the sign-in pane), which jsx-a11y cannot see
    // react-doctor-disable-next-line react-doctor/prefer-html-dialog, react-doctor/click-events-have-key-events -- full-screen OS lock surface, not a modal: dismisses via click/any-key then the user tile, behaviors the native <dialog> focus model does not support; keyboard parity is the document keydown listener above (any key raises the sign-in pane)
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Windows 11 lock screen"
      className="os-win11-lock"
      style={{ zIndex: SHELL_Z_INDEX.lockScreen }}
      onClick={() => {
        if (phase === "clock") setPhase("signin");
      }}
    >
      {phase === "clock" ? (
        <>
          <Win11LockClock />
          <p className="os-win11-lock-hint">Click or press any key to sign in</p>
        </>
      ) : (
        <button type="button" className="os-win11-lock-tile" onClick={close}>
          <StartMenuUser avatarSize={64} className="os-win11-lock-user" />
        </button>
      )}
    </div>
  );
}
