import { Linking } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import HelpCircleIcon from "@hugeicons/core-free-icons/HelpCircleIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import LegalDocument01Icon from "@hugeicons/core-free-icons/LegalDocument01Icon";
import Shield01Icon from "@hugeicons/core-free-icons/Shield01Icon";

import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Icon } from "@/components/ui";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL, openLegalLink } from "@/lib/legal-links";

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
        <SettingsRow
          card
          title="Privacy Policy"
          detail="How Matrix OS handles your data"
          icon={Shield01Icon}
          accessibilityLabel="Open privacy policy"
          trailing={<Icon icon={ArrowUpRight01Icon} size={18} color={theme.v2.appColors.muted} />}
          onPress={() => openLegalLink(PRIVACY_POLICY_URL)}
        />
        <SettingsRow
          card
          title="Terms of Service"
          detail="The agreement for using Matrix OS"
          icon={LegalDocument01Icon}
          accessibilityLabel="Open terms of service"
          trailing={<Icon icon={ArrowUpRight01Icon} size={18} color={theme.v2.appColors.muted} />}
          onPress={() => openLegalLink(TERMS_OF_SERVICE_URL)}
        />
      </SettingsCardStack>
    </SettingsPage>
  );
}
