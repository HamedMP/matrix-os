import { Linking } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useUser } from "@clerk/clerk-expo";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import { Image } from "expo-image";

import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Icon, Spacer } from "@/components/ui";

const ACCOUNT_URL = "https://accounts.matrix-os.com/user";

export default function AccountSettingsScreen() {
  const { user } = useUser();
  const { theme } = useUnistyles();
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
