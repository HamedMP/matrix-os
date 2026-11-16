"use client";

import { useEffect } from "react";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useDesktopMode } from "@/stores/desktop-mode";
import { enqueueExistingTerminalRef } from "@/lib/provider-terminal-session";
import { OPEN_TERMINAL_SESSION_EVENT, terminalSessionFromOpenEvent } from "@/lib/terminal-session-open";

function durableTerminalWindow() {
  return useWindowManager.getState().windows.find((w) => (
    w.path === "__terminal__" && w.terminalPersistence !== "ephemeral" && !w.sharedTerminalScopeId
  ));
}

/**
 * Shows a requested terminal tab in the durable Terminal window, opening one if
 * none exists. The durable window backgrounds tabs on close instead of ending
 * them, so a running agent survives the person closing the window again.
 */
export function useOpenTerminalSession(dockXOffset: number): void {
  useEffect(() => {
    const open = (event: Event) => {
      const sessionId = terminalSessionFromOpenEvent(event);
      if (!sessionId) return;
      const manager = useWindowManager.getState();
      const existing = durableTerminalWindow();
      if (existing) manager.restoreAndFocusWindow(existing.id);
      else manager.openWindow("Terminal", "__terminal__", dockXOffset);
      requestAnimationFrame(() => {
        const win = durableTerminalWindow();
        if (!win) return;
        if (useDesktopMode.getState().mode === "canvas") {
          const rect = useCanvasTransform.getState().containerRect;
          useCanvasTransform.getState().focusOnWindow(win, rect?.width ?? window.innerWidth, rect?.height ?? window.innerHeight);
        }
        enqueueExistingTerminalRef(sessionId, win.id);
      });
    };
    window.addEventListener(OPEN_TERMINAL_SESSION_EVENT, open);
    return () => window.removeEventListener(OPEN_TERMINAL_SESSION_EVENT, open);
  }, [dockXOffset]);
}
