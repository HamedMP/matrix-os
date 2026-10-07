"use client";

import { useEffect, useRef, type RefObject } from "react";
import { shouldOpenChatOnStartup } from "@matrix-os/ui";
import { useDesktopMode } from "@/stores/desktop-mode";
import { isPreVpsBillingSetupRoute } from "@/lib/pre-vps-shell";
import { useWindowManager } from "@/hooks/useWindowManager";

export function useDesktopChatStartup({
  entryKey, settled, navigationChangedRef, launchAppPath, sharedTerminalScopeId,
  apps, dockXOffset, focusCanvasWindow, openAppOrFocus,
}: {
  entryKey: string;
  settled: boolean;
  navigationChangedRef: RefObject<boolean>;
  launchAppPath?: string | null;
  sharedTerminalScopeId?: string | null;
  apps: readonly { name: string; path: string }[];
  dockXOffset: number;
  focusCanvasWindow: (id: string) => void;
  openAppOrFocus: (path: string, name: string) => void;
}) {
  const launchPathConsumedRef = useRef<string | null>(null);
  const startupRef = useRef({ entryKey, consumed: false });
  const modeHydrated = useDesktopMode((state) => state._hydrated);
  useEffect(() => {
    if (startupRef.current.entryKey === entryKey) return;
    startupRef.current = { entryKey, consumed: false };
    launchPathConsumedRef.current = null;
  }, [entryKey]);
  const wmOpenWindow = useWindowManager((s) => s.openWindow);
  const wmRestoreAndFocusWindow = useWindowManager((s) => s.restoreAndFocusWindow);
  useEffect(() => {
    // Explicit entry requests remain authoritative after early navigation;
    // the navigation guard applies only to the automatic Chat launch below.
    if (!settled || !modeHydrated || !launchAppPath) return;
    const launchRequestKey = sharedTerminalScopeId
      ? `${launchAppPath}?sharedScope=${encodeURIComponent(sharedTerminalScopeId)}`
      : launchAppPath;
    if (launchPathConsumedRef.current === launchRequestKey) return;
    if (sharedTerminalScopeId) {
      launchPathConsumedRef.current = launchRequestKey;
      const existing = useWindowManager.getState().windows.find((windowRecord) => (
        windowRecord.path === "__terminal__"
        && windowRecord.sharedTerminalScopeId === sharedTerminalScopeId
      ));
      if (existing) {
        wmRestoreAndFocusWindow(existing.id);
        focusCanvasWindow(existing.id);
      } else {
        wmOpenWindow("Shared Terminal", "__terminal__", dockXOffset, {
          terminalPersistence: "ephemeral",
          sharedTerminalScopeId,
        });
        requestAnimationFrame(() => {
          const opened = useWindowManager.getState().windows.find((windowRecord) => (
            windowRecord.path === "__terminal__"
            && windowRecord.sharedTerminalScopeId === sharedTerminalScopeId
          ));
          if (opened) focusCanvasWindow(opened.id);
        });
      }
      return;
    }
    const match = apps.find((app) => app.path === launchAppPath);
    if (!match) return;
    launchPathConsumedRef.current = launchRequestKey;
    openAppOrFocus(match.path, match.name);
  }, [modeHydrated, settled, navigationChangedRef, apps, dockXOffset, focusCanvasWindow, launchAppPath, openAppOrFocus,
    sharedTerminalScopeId, wmOpenWindow, wmRestoreAndFocusWindow]);

  useEffect(() => {
    const startup = startupRef.current;
    if (!settled || !modeHydrated || startup.consumed) return;
    const open = shouldOpenChatOnStartup({
      settled, consumed: startup.consumed,
      explicitLaunch: Boolean(launchAppPath || sharedTerminalScopeId) || isPreVpsBillingSetupRoute(),
      navigationChanged: navigationChangedRef.current,
      chatOpen: useWindowManager.getState().windows.some((w) => w.path === "__chat__"),
    });
    startup.consumed = true;
    if (open) openAppOrFocus("__chat__", "Chat");
  }, [entryKey, modeHydrated, settled, launchAppPath, sharedTerminalScopeId, navigationChangedRef, openAppOrFocus]);
}
