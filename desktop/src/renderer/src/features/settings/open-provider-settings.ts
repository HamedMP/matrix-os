import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

/** Navigation is local and must remain available while provider checks load. */
export function openProviderSettings(): void {
  useUi.getState().requestSettingsSection("agents-providers");
  useTabs.getState().openTab({ kind: "settings", title: "Settings" });
}
