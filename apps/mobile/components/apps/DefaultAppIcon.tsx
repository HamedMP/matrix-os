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

import { APP_ARTWORK_FOOTPRINT, APP_ICON_SQUIRCLE } from "./app-icon-shape";

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
    width: APP_ARTWORK_FOOTPRINT,
    height: APP_ARTWORK_FOOTPRINT,
    alignItems: "center",
    justifyContent: "center",
  },
  artwork: {
    ...APP_ICON_SQUIRCLE,
    alignItems: "center",
    justifyContent: "center",
  },
});
