import * as Application from "expo-application";
import Constants from "expo-constants";

import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Spacer, Text } from "@/components/ui";
import { useSettingsSystemInfo } from "@/lib/queries/use-settings-system-info";

export default function SystemSettingsScreen() {
  const { computer, systemInfo, isPending, isError } = useSettingsSystemInfo();
  const appVersion = Application.nativeApplicationVersion
    ?? Constants.expoConfig?.version
    ?? "Unknown";
  const releaseVersion = systemInfo?.release?.version
    ?? systemInfo?.runningVersion
    ?? systemInfo?.version
    ?? computer?.versionLabel
    ?? (isPending ? "Loading…" : "Unavailable");
  const modelInformation = systemInfo
    ? `${systemInfo.model} · ${systemInfo.effort}`
    : isPending ? "Loading…" : "Unavailable";

  return (
    <SettingsPage>
      <SettingsCardStack>
        <SettingsRow card title="App version" detail={appVersion} />
        <SettingsRow card title="VPS release version" detail={releaseVersion} />
        <SettingsRow card title="Model information" detail={modelInformation} />
      </SettingsCardStack>
      {isError ? (
        <>
          <Spacer size="md" />
          <Text size="muted" tone="subtle">Some VPS information could not be loaded.</Text>
        </>
      ) : null}
    </SettingsPage>
  );
}
