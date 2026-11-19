"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Lets window content place controls in its own window title bar (Web Desktop
 * and Web Canvas). `null` clears them. Electron Desktop uses SurfaceChrome.
 */
export const WindowTitleBarActionsContext = createContext<((actions: ReactNode | null) => void) | null>(null);

export function useWindowTitleBarActions(): ((actions: ReactNode | null) => void) | null {
  return useContext(WindowTitleBarActionsContext);
}
