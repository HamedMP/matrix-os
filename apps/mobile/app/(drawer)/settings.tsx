import { Alert } from "react-native";
import { useAuth } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import ComputerSettingsIcon from "@hugeicons/core-free-icons/ComputerSettingsIcon";
import CreditCardIcon from "@hugeicons/core-free-icons/CreditCardIcon";
import HelpCircleIcon from "@hugeicons/core-free-icons/HelpCircleIcon";
import Logout01Icon from "@hugeicons/core-free-icons/Logout01Icon";
import Settings02Icon from "@hugeicons/core-free-icons/Settings02Icon";
import UserIcon from "@hugeicons/core-free-icons/UserIcon";

import { MockPage } from "@/components/mock-shell/MockPage";
import { SettingsCardStack, SettingsRow } from "@/components/settings/SettingsSurface";
import { resetAnalytics } from "@/lib/analytics";
import { clearAllScrollback } from "@/lib/terminal-scrollback";

export default function SettingsScreen() {
  const router = useRouter();
  const { signOut } = useAuth();

  function confirmSignOut() {
    Alert.alert("Sign out?", "You’ll return to the sign-in screen.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          clearAllScrollback();
          resetAnalytics();
          void signOut()
            .then(() => router.replace("/sign-in" as never))
            .catch((error: unknown) => {
              console.warn("[mobile] sign-out failed", error instanceof Error ? error.name : "unknown");
              Alert.alert("Sign out failed", "Try again in a moment.");
            });
        },
      },
    ]);
  }

  return (
    <MockPage title="Settings" subtitle="Manage Matrix OS and your account">
      <SettingsCardStack>
        <SettingsRow
          card
          title="System"
          detail="Versions and model information"
          icon={ComputerSettingsIcon}
          onPress={() => router.push("/settings-detail/system" as never)}
        />
        <SettingsRow
          card
          title="Account"
          detail="Profile and account management"
          icon={UserIcon}
          onPress={() => router.push("/settings-detail/account" as never)}
        />
        <SettingsRow
          card
          title="App settings"
          detail="Theme, security, and notifications"
          icon={Settings02Icon}
          onPress={() => router.push("/settings-detail/app-settings" as never)}
        />
        <SettingsRow
          card
          title="Billing"
          detail="Plan and subscription"
          icon={CreditCardIcon}
          onPress={() => router.push("/settings-detail/billing" as never)}
        />
        <SettingsRow
          card
          title="Help"
          detail="Docs and support"
          icon={HelpCircleIcon}
          onPress={() => router.push("/settings-detail/help" as never)}
        />
        <SettingsRow
          card
          title="Sign out"
          icon={Logout01Icon}
          tone="danger"
          accessibilityLabel="Sign out"
          onPress={confirmSignOut}
        />
      </SettingsCardStack>
    </MockPage>
  );
}
