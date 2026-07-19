"use client";

import type { ReactNode } from "react";
import type { AppEntry, AppWindow } from "@/hooks/useWindowManager";
import { XpTaskbar } from "./XpTaskbar";
import { Win11Taskbar } from "./Win11Taskbar";
import "./taskbar.css";

/**
 * Props wired by Desktop.tsx. `children` is the optional canvas-mode toolbar
 * slot — rendered in the taskbar's right area before the tray (ignored in
 * desktop mode, where Desktop passes null).
 */
export interface WindowsTaskbarProps {
  themeStyle: string;
  apps: AppEntry[];
  windows: AppWindow[];
  onOpenApp: (path: string, name?: string) => void;
  onFocusWindow: (id: string) => void;
  onMinimizeWindow: (id: string) => void;
  onOpenSettings: () => void;
  onOpenCommandPalette: () => void;
  children?: ReactNode;
}

/**
 * Replaces the mac-style MenuBar + dock with an authentic Windows bottom
 * taskbar + start menu while the active design is `winxp` or `win11`.
 * Renders nothing for every other design.
 */
export function WindowsTaskbar(props: WindowsTaskbarProps) {
  if (props.themeStyle === "winxp") return <XpTaskbar {...props} />;
  if (props.themeStyle === "win11") return <Win11Taskbar {...props} />;
  return null;
}
