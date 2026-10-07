import { useUi } from "../../stores/ui";
import { useTabs } from "../../stores/tabs";

export function openChatProviderSettings(): void {
  useUi.getState().requestSettingsSection("agents-providers");
  useTabs.getState().openTab({ kind: "settings", title: "Settings" });
}
