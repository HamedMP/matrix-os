import type { AgentSetupResource } from "@matrix-os/ui";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

/** Navigation is local and must remain available while provider checks load. */
export function openProviderSettings(): void {
  openSettingsSection("agents-providers");
}

const agentSettingsSections = { integrations: "services", mcp: "mcps", skills: "skills" } as const;

export function openAgentResourceSettings(resource: AgentSetupResource): void {
  openSettingsSection(agentSettingsSections[resource]);
}

function openSettingsSection(section: "agents-providers" | typeof agentSettingsSections[AgentSetupResource]): void {
  useUi.getState().requestSettingsSection(section);
  const tabId = useTabs.getState().openTab({ kind: "settings", title: "Settings" });
  // Selecting a retained tab does not restore a minimized or hidden window.
  useDesktopSurfaces.getState().activateSurface(tabId);
}
