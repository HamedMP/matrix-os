import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

/** Navigation is local and must remain available while provider checks load. */
export function openProviderSettings(): void {
  useUi.getState().requestSettingsSection("agents-providers");
  const tabId = useTabs.getState().openTab({ kind: "settings", title: "Settings" });
  // Selecting a retained tab does not restore a minimized or hidden window.
  useDesktopSurfaces.getState().activateSurface(tabId);
}
