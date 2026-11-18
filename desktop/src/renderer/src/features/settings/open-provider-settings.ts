import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import type { SettingsSectionId } from "./SettingsView";

/** Navigation is local and must remain available while provider checks load. */
export function openSettingsSection(section: SettingsSectionId): void {
  useUi.getState().requestSettingsSection(section);
  const tabId = useTabs.getState().openTab({ kind: "settings", title: "Settings" });
  // Selecting a retained tab does not restore a minimized or hidden window.
  useDesktopSurfaces.getState().activateSurface(tabId);
}

export function openProviderSettings(): void {
  openSettingsSection("agents-providers");
}
