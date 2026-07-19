"use client";

import { create } from "zustand";
import type { OsBootDesign } from "./os-session-utils";

/**
 * Session overlays for the OS lock / user-switch / log-off simulation. This is
 * a simulation only: nothing here touches Clerk sign-out or real power state.
 * The views are design-keyed by their openers (the XP start menu opens the XP
 * dialog, the Win11 flyout the Win11 lock screen, the Apple menu the macOS
 * lock screen), so the active view always matches the active design.
 */
export type OsSessionView =
  | "none"
  | "xp-logoff"
  | "xp-shutdown"
  | "xp-welcome"
  | "xp-safe-off"
  | "win11-lock"
  | "macos-lock";

interface OsSessionState {
  view: OsSessionView;
  /** Non-null while a boot screen (design-switch beat, restart replay) is up. */
  bootDesign: OsBootDesign | null;
  /** Increments on every beat so back-to-back beats retrigger the dismiss timer. */
  bootId: number;
  openXpLogoff: () => void;
  openXpShutdown: () => void;
  showXpWelcome: () => void;
  showXpSafeOff: () => void;
  openWin11Lock: () => void;
  openMacosLock: () => void;
  /** Replays the boot screen; also dismisses any open session overlay. */
  beginBoot: (design: OsBootDesign) => void;
  endBoot: () => void;
  close: () => void;
}

export const useOsSessionStore = create<OsSessionState>()((set) => ({
  view: "none",
  bootDesign: null,
  bootId: 0,
  openXpLogoff: () => set({ view: "xp-logoff" }),
  openXpShutdown: () => set({ view: "xp-shutdown" }),
  showXpWelcome: () => set({ view: "xp-welcome" }),
  showXpSafeOff: () => set({ view: "xp-safe-off" }),
  openWin11Lock: () => set({ view: "win11-lock" }),
  openMacosLock: () => set({ view: "macos-lock" }),
  beginBoot: (design) => set((s) => ({ view: "none", bootDesign: design, bootId: s.bootId + 1 })),
  endBoot: () => set({ bootDesign: null }),
  close: () => set({ view: "none" }),
}));

/** Test hook: restore the initial session state between tests. */
// react-doctor-disable-next-line deslop/unused-export -- consumed by the shell test suites (tests/shell/os-session.test.tsx, tests/shell/windows-taskbar.test.tsx); mirrors resetConnectionHealthState in hooks/useConnectionHealth
export function resetOsSession() {
  useOsSessionStore.setState({ view: "none", bootDesign: null, bootId: 0 });
}
