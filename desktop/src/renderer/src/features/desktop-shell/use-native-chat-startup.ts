import { useEffect, useRef } from "react";
import type { OsViewStateResponse } from "@matrix-os/contracts";
import { shouldOpenChatOnStartup } from "@matrix-os/ui";
import { useTabs } from "../../stores/tabs";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import type { MatrixApp } from "../apps/apps.api";
import { nativeTabOsViewPath } from "./native-os-view-persistence";

/** Capture live navigation separately from our own restoration writes. */
export function useNativeStartupNavigation(entryKey: string) {
  const navigationChangedRef = useRef(false);
  const restoringRef = useRef(false);
  const currentEntryRef = useRef(entryKey);
  useEffect(() => {
    if (currentEntryRef.current === entryKey) return;
    currentEntryRef.current = entryKey;
    navigationChangedRef.current = false;
  }, [entryKey]);
  useEffect(() => {
    const stopTabs = useTabs.subscribe((state, previous) => {
      if (!restoringRef.current && (state.tabs !== previous.tabs || state.activeTabId !== previous.activeTabId)) {
        navigationChangedRef.current = true;
      }
    });
    const stopSurfaces = useDesktopSurfaces.subscribe((state, previous) => {
      if (!restoringRef.current && Object.values(state.surfaces).some((surface) =>
        surface.mode === "closed" && previous.surfaces[surface.tabId]?.mode !== "closed")) {
        navigationChangedRef.current = true;
      }
    });
    return () => { stopTabs(); stopSurfaces(); };
  }, [entryKey]);
  return { navigationChangedRef, restoringRef };
}

export function useNativeChatStartup(input: {
  entryKey: string;
  loadSettled: boolean;
  surfacesRestored: boolean;
  modeHydrated: boolean;
  catalogSettled: boolean;
  durableState: OsViewStateResponse | null;
  installedApps: readonly MatrixApp[];
  destinations: readonly { path: string; open: () => void }[];
  navigationChangedRef: { current: boolean };
  restoringRef: { current: boolean };
  openChat: () => void;
}) {
  const stateRef = useRef({ entryKey: input.entryKey, consumed: false, restored: false, openedPaths: new Set<string>() });
  useEffect(() => {
    if (stateRef.current.entryKey === input.entryKey) return;
    stateRef.current = { entryKey: input.entryKey, consumed: false, restored: false, openedPaths: new Set<string>() };
  }, [input.entryKey]);
  useEffect(() => {
    const startup = stateRef.current;
    if (!input.loadSettled || !input.modeHydrated || !input.catalogSettled || startup.consumed) return;
    if (input.navigationChangedRef.current) { startup.consumed = true; return; }
    const initialTabs = useTabs.getState();
    let opened = false;
    input.restoringRef.current = true;
    try {
      if (!startup.restored) {
        const currentPaths = new Set(initialTabs.tabs.flatMap((tab) => {
          const path = nativeTabOsViewPath(tab, input.installedApps);
          return path ? [path] : [];
        }));
        for (const app of input.durableState?.document.apps ?? []) {
          if (app.state === "closed" || startup.openedPaths.has(app.path) || currentPaths.has(app.path)) continue;
          const destinationPath = app.path.startsWith("__terminal__:") ? "__terminal__" : app.path;
          const destination = input.destinations.find((candidate) => candidate.path === destinationPath);
          if (!destination) continue;
          startup.openedPaths.add(app.path);
          destination.open();
          opened = true;
          if (app.path.startsWith("__terminal__:") && app.path.length > "__terminal__:".length) {
            useTabs.getState().requestTerminalSession(app.path.slice("__terminal__:".length));
          }
        }
        // Restoring another app must not replace an already selected conversation.
        if (initialTabs.activeTabId) useTabs.getState().focusTab(initialTabs.activeTabId);
        startup.restored = true;
      }
      if (opened || !input.surfacesRestored) return;
      const chat = useTabs.getState().tabs.find((tab) => tab.kind === "work");
      const chatOpen = Boolean(chat && useDesktopSurfaces.getState().surfaces[chat.id]?.mode !== "closed");
      const open = shouldOpenChatOnStartup({
        settled: true, consumed: startup.consumed,
        // A native destination already present before restoration is an explicit entry.
        explicitLaunch: initialTabs.tabs.length > 0 && !chat && startup.openedPaths.size === 0,
        navigationChanged: input.navigationChangedRef.current, chatOpen,
      });
      startup.consumed = true;
      if (open) input.openChat();
    } finally { input.restoringRef.current = false; }
  }, [input]);
}
