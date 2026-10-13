import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import {
  ChatIcon,
  ConnectAppsIcon,
  FolderIcon,
  Icon,
  SettingsTabIcon,
  TerminalTabIcon,
  type IconData,
} from "@/components/ui";
import { defaultAppColors, type DefaultAppId } from "@/lib/apps-launcher";

const ICONS: Record<DefaultAppId, IconData> = {
  chat: ChatIcon,
  terminal: TerminalTabIcon,
  files: FolderIcon,
  settings: SettingsTabIcon,
  plugins: ConnectAppsIcon,
};

/** A default app's tile artwork: the desktop launcher's coloured square, sized like `AppLogo`. */
export function DefaultAppIcon({ id, name }: { id: DefaultAppId; name: string }) {
  const { background, foreground } = defaultAppColors(id);

  return (
    <View testID={`app-logo-${name}`} style={styles.container}>
      <View testID={`default-app-icon-${name}`} style={[styles.artwork, { backgroundColor: background }]}>
        <Icon icon={ICONS[id]} size={30} color={foreground} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 68,
    height: 68,
    alignItems: "center",
    justifyContent: "center",
  },
  artwork: {
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
  },
});
