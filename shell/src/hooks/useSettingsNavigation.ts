"use client";

import { useCallback, useState } from "react";
import type { SettingsSectionId } from "@/components/Settings";

const DEFAULT_SECTION: SettingsSectionId = "agents-providers";

/** Explicit links choose a section; generic Settings openings always start at agent setup. */
export function useSettingsNavigation() {
  const [state, setState] = useState<{ open: boolean; section: SettingsSectionId; requestId: number }>({ open: false, section: DEFAULT_SECTION, requestId: 0 });
  const openSettings = useCallback((section: SettingsSectionId = DEFAULT_SECTION) => {
    setState(previous => ({ open: true, section, requestId: previous.requestId + 1 }));
  }, []);
  const toggleSettings = useCallback(() => {
    setState((previous) => ({
      open: !previous.open,
      section: previous.open ? previous.section : DEFAULT_SECTION,
      requestId: previous.open ? previous.requestId : previous.requestId + 1,
    }));
  }, []);
  const setSettingsOpen = useCallback((open: boolean) => {
    setState((previous) => ({ ...previous, open }));
  }, []);

  return {
    settingsOpen: state.open,
    settingsDefaultSection: state.section,
    settingsNavigationRequestId: state.requestId,
    openSettings,
    toggleSettings,
    setSettingsOpen,
  };
}
