import { Linking } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useUser } from "@clerk/clerk-expo";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import { Image } from "expo-image";
import { useRouter } from "expo-router";

import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Icon, Spacer } from "@/components/ui";
import { formatDeletionDeadline } from "@/lib/account-deletion";
import { useAccountDeletion } from "@/lib/queries/use-account-deletion";
import type { AccountDeletionStatus } from "@/lib/requests";

const ACCOUNT_URL = "https://accounts.matrix-os.com/user";

function deletionDetail(status: AccountDeletionStatus | undefined): string {
  if (status?.status === "scheduled") {
    const deadline = formatDeletionDeadline(status, "date");
    return deadline ? `Deletion scheduled for ${deadline}` : "Deletion scheduled";
  }
  if (status?.status === "processing") return "Deletion in progress";
  return "Permanently delete your account and data";
}

export default function AccountSettingsScreen() {
  const { user } = useUser();
  const { theme } = useUnistyles();
  const router = useRouter();
  const deletion = useAccountDeletion();
  const name = user?.fullName ?? user?.firstName ?? "Not set";
  const handle = user?.username ? `@${user.username}` : "Not set";

  return (
    <SettingsPage>
      {user?.imageUrl ? (
        <>
          <Image
            source={{ uri: user.imageUrl }}
            accessibilityLabel={`${name} profile image`}
            style={styles.avatar}
          />
          <Spacer size="xl" />
        </>
      ) : null}
      <SettingsCardStack>
        <SettingsRow card title="Handle" detail={handle} />
        <SettingsRow card title="Name" detail={name} />
        <SettingsRow
          card
          title="Manage account"
          detail="Opens in your browser"
          accessibilityLabel="Manage account"
          trailing={<Icon icon={ArrowUpRight01Icon} size={18} color={theme.v2.appColors.muted} />}
          onPress={() => void Linking.openURL(ACCOUNT_URL)}
        />
      </SettingsCardStack>
      {deletion.enabled ? (
        <>
          <Spacer size="xl" />
          <SettingsRow
            card
            title="Delete account"
            detail={deletionDetail(deletion.status)}
            tone="danger"
            accessibilityLabel="Delete account"
            onPress={() => router.push("/settings-detail/delete-account" as never)}
          />
        </>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create((theme) => ({
  avatar: {
    width: 108,
    height: 108,
    borderRadius: 54,
    borderWidth: 6,
    borderColor: theme.v2.palette.green[600],
    alignSelf: "center",
  },
}));
