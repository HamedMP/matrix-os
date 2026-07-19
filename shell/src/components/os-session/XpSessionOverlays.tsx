"use client";

import {
  KeyRoundIcon,
  MoonIcon,
  PowerIcon,
  RotateCcwIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { StartMenuUser, XpFlagLogo } from "../taskbar/taskbar-shared";
import { useOsSessionStore } from "./os-session-store";

/**
 * Windows XP session overlays (log-off/shutdown dialogs, Welcome screen,
 * safe-to-turn-off screen). Simulation only — every path returns to the
 * running desktop; no real sign-out or power wiring. Styling: os-session.css.
 */

/** Classic "Log Off Windows" dialog: Switch User / Log Off / Cancel. */
export function XpLogoffDialog() {
  const showWelcome = useOsSessionStore((s) => s.showXpWelcome);
  const close = useOsSessionStore((s) => s.close);
  return (
    <div className="os-xp-dialog-backdrop" style={{ zIndex: SHELL_Z_INDEX.lockScreen }}>
      <button type="button" className="os-xp-dialog-scrim" aria-label="Close" onClick={close} />
      {/* react-doctor-disable-next-line react-doctor/prefer-html-dialog -- OS-authentic themed dialog: needs the XP titlebar chrome and Luna styling that the native <dialog> UA stylesheet/focus trapping fight against; Escape/backdrop/Cancel dismissal is wired by hand */}
      <div role="dialog" aria-modal="true" aria-label="Log Off Windows" className="os-xp-dialog">
        <div className="os-xp-dialog-titlebar">
          <span>Log Off Windows</span>
          <button type="button" className="os-xp-dialog-close" aria-label="Close" onClick={close}>
            <XIcon aria-hidden="true" />
          </button>
        </div>
        <div className="os-xp-dialog-body">
          <button type="button" className="os-xp-dialog-action" onClick={showWelcome}>
            <span className="os-xp-dialog-chip os-xp-chip-switch" aria-hidden="true">
              <UsersIcon />
            </span>
            <span>Switch User</span>
          </button>
          <button type="button" className="os-xp-dialog-action" onClick={showWelcome}>
            <span className="os-xp-dialog-chip os-xp-chip-logoff" aria-hidden="true">
              <KeyRoundIcon />
            </span>
            <span>Log Off</span>
          </button>
          <button type="button" className="os-xp-dialog-action" onClick={close}>
            <span className="os-xp-dialog-chip os-xp-chip-cancel" aria-hidden="true">
              <XIcon />
            </span>
            <span>Cancel</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Classic "Turn off computer" dialog: Stand By / Turn Off / Restart. */
export function XpShutdownDialog() {
  const showSafeOff = useOsSessionStore((s) => s.showXpSafeOff);
  const beginBoot = useOsSessionStore((s) => s.beginBoot);
  const close = useOsSessionStore((s) => s.close);
  return (
    <div className="os-xp-dialog-backdrop" style={{ zIndex: SHELL_Z_INDEX.lockScreen }}>
      <button type="button" className="os-xp-dialog-scrim" aria-label="Close" onClick={close} />
      {/* react-doctor-disable-next-line react-doctor/prefer-html-dialog -- OS-authentic themed dialog: needs the XP titlebar chrome and Luna styling that the native <dialog> UA stylesheet/focus trapping fight against; Escape/backdrop dismissal is wired by hand */}
      <div role="dialog" aria-modal="true" aria-label="Turn off computer" className="os-xp-dialog">
        <div className="os-xp-dialog-titlebar">
          <span>Turn off computer</span>
          <button type="button" className="os-xp-dialog-close" aria-label="Close" onClick={close}>
            <XIcon aria-hidden="true" />
          </button>
        </div>
        <div className="os-xp-dialog-body">
          <button type="button" className="os-xp-dialog-action" onClick={() => beginBoot("winxp")}>
            <span className="os-xp-dialog-chip os-xp-chip-standby" aria-hidden="true">
              <MoonIcon />
            </span>
            <span>Stand By</span>
          </button>
          <button type="button" className="os-xp-dialog-action" onClick={showSafeOff}>
            <span className="os-xp-dialog-chip os-xp-chip-power" aria-hidden="true">
              <PowerIcon />
            </span>
            <span>Turn Off</span>
          </button>
          <button type="button" className="os-xp-dialog-action" onClick={() => beginBoot("winxp")}>
            <span className="os-xp-dialog-chip os-xp-chip-restart" aria-hidden="true">
              <RotateCcwIcon />
            </span>
            <span>Restart</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** XP Welcome screen: blue radial gradient, wordmark, clickable user tile. */
export function XpWelcomeScreen() {
  const close = useOsSessionStore((s) => s.close);
  return (
    // react-doctor-disable-next-line react-doctor/prefer-html-dialog -- full-screen OS surface, not a modal: the XP Welcome screen has no dialog frame, no backdrop, and dismisses via its user tile / Escape; native <dialog> semantics do not fit
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Windows XP Welcome screen"
      className="os-xp-welcome"
      style={{ zIndex: SHELL_Z_INDEX.lockScreen }}
    >
      <div className="os-xp-welcome-brand">
        <XpFlagLogo size={44} />
        <span className="os-xp-welcome-wordmark">
          <span className="os-xp-welcome-microsoft">Microsoft</span>
          <span className="os-xp-welcome-windows">
            Windows<span className="os-xp-welcome-edition">XP</span>
          </span>
        </span>
      </div>
      <div className="os-xp-welcome-panel">
        <button type="button" className="os-xp-welcome-tile" onClick={close}>
          <StartMenuUser avatarSize={48} className="os-xp-welcome-user" />
        </button>
        <p className="os-xp-welcome-caption">To begin, click your user name</p>
      </div>
    </div>
  );
}

/** Post-shutdown black screen; any click wakes back to the desktop. */
export function XpSafeOffScreen() {
  const close = useOsSessionStore((s) => s.close);
  return (
    <button
      type="button"
      className="os-xp-safeoff"
      style={{ zIndex: SHELL_Z_INDEX.lockScreen }}
      onClick={close}
    >
      <span>It is now safe to turn off your computer.</span>
      <span className="os-xp-safeoff-hint">Click anywhere to wake</span>
    </button>
  );
}
