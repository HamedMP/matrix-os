import { ConnectAppsScreen } from "@/components/integrations/ConnectAppsScreen";

/** Connect Apps opened from Settings, where the settings header names the screen. */
export default function ConnectAppsSettingsScreen() {
  return <ConnectAppsScreen openedFrom="settings" />;
}
