"use client";

import { useCallback, useState } from "react";
import type { SettingsSectionId } from "@/components/Settings";

const DEFAULT_SECTION: SettingsSectionId = "agents-providers";

/** Explicit links choose a section; generic Settings openings always start at agent setup. */
export function useSettingsNavigation() {
  const [state, setState] = useState<{ open: boolean; section: SettingsSectionId }>({ open: false, section: DEFAULT_SECTION });
  const openSettings = useCallback((section: SettingsSectionId = DEFAULT_SECTION) => {
    setState({ open: true, section });
  }, []);
  const toggleSettings = useCallback(() => {
    setState((previous) => ({
      open: !previous.open,
      section: previous.open ? previous.section : DEFAULT_SECTION,
    }));
  }, []);
  const setSettingsOpen = useCallback((open: boolean) => {
    setState((previous) => ({ ...previous, open }));
  }, []);

  return {
    settingsOpen: state.open,
    settingsDefaultSection: state.section,
    openSettings,
    toggleSettings,
    setSettingsOpen,
  };
}
