import { Linking } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import DiscordIcon from "@hugeicons/core-free-icons/DiscordIcon";
import Mail01Icon from "@hugeicons/core-free-icons/Mail01Icon";

import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Icon } from "@/components/ui";

const SUPPORT_EMAIL = "support@matrix-os.com";
const DISCORD_URL = "https://discord.gg/cSBBQWtPwV";

export default function SupportSettingsScreen() {
  const { theme } = useUnistyles();
  return (
    <SettingsPage>
      <SettingsCardStack>
        <SettingsRow
          card
          title="Email"
          detail={SUPPORT_EMAIL}
          icon={Mail01Icon}
          accessibilityLabel="Email support"
          trailing={<Icon icon={ArrowUpRight01Icon} size={18} color={theme.v2.appColors.muted} />}
          onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
        />
        <SettingsRow
          card
          title="Join Discord"
          detail="Ask questions and meet the community"
          icon={DiscordIcon}
          accessibilityLabel="Join Discord"
          trailing={<Icon icon={ArrowUpRight01Icon} size={18} color={theme.v2.appColors.muted} />}
          onPress={() => void Linking.openURL(DISCORD_URL)}
        />
      </SettingsCardStack>
    </SettingsPage>
  );
}
