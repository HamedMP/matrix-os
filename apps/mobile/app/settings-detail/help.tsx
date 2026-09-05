import { Linking } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import HelpCircleIcon from "@hugeicons/core-free-icons/HelpCircleIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";

import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Icon } from "@/components/ui";

const DOCS_URL = "https://matrix-os.com/docs";

export default function HelpSettingsScreen() {
  const router = useRouter();
  const { theme } = useUnistyles();
  return (
    <SettingsPage>
      <SettingsCardStack>
        <SettingsRow
          card
          title="Docs"
          detail="Guides and product documentation"
          icon={InformationCircleIcon}
          accessibilityLabel="Open docs"
          trailing={<Icon icon={ArrowUpRight01Icon} size={18} color={theme.v2.appColors.muted} />}
          onPress={() => void Linking.openURL(DOCS_URL)}
        />
        <SettingsRow
          card
          title="Contact support"
          detail="Email and community support"
          icon={HelpCircleIcon}
          onPress={() => router.push("/settings-detail/support" as never)}
        />
      </SettingsCardStack>
    </SettingsPage>
  );
}
