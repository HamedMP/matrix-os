import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

/** Navigation is local and must remain available while provider checks load. */
export function openProviderSettings(): void {
  openSettingsSection("agents-providers");
}

export function openAgentResourceSettings(resource: "integrations" | "mcp"): void {
  openSettingsSection(resource === "mcp" ? "mcps" : "services");
}

function openSettingsSection(section: "agents-providers" | "mcps" | "services"): void {
  useUi.getState().requestSettingsSection(section);
  const tabId = useTabs.getState().openTab({ kind: "settings", title: "Settings" });
  // Selecting a retained tab does not restore a minimized or hidden window.
  useDesktopSurfaces.getState().activateSurface(tabId);
}
