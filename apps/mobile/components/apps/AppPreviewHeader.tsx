import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { IconButton } from "@/components/ui";

const BAR_HEIGHT = 36;
const BAR_INSET = 10;
const MIN_TOUCH_TARGET = 44;

/**
 * Title bar for a running app. Apps bring their own header, so this stays
 * shorter than the native navigation bar, whose height cannot be changed.
 */
export function AppPreviewHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();

  return (
    <View
      testID="app-preview-header"
      style={[
        styles.header,
        { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right },
      ]}
    >
      <View testID="app-preview-header-bar" style={styles.bar}>
        <IconButton
          accessibilityLabel="Close app"
          icon={Cancel01Icon}
          iconSize={20}
          iconColor={theme.v2.appColors.ink}
          iconTestID="app-preview-close-icon"
          buttonSize={BAR_HEIGHT}
          // Grow the target into the status bar area and the bar's side inset;
          // anything below the bar belongs to the app.
          hitSlop={{ top: MIN_TOUCH_TARGET - BAR_HEIGHT, bottom: 0, left: BAR_INSET, right: BAR_INSET }}
          onPress={onClose}
        />
        <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <View style={styles.balance} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.v2.appColors.canvas,
  },
  bar: {
    height: BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: BAR_INSET,
  },
  title: {
    flex: 1,
    textAlign: "center",
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 14,
    color: theme.v2.appColors.ink,
  },
  // Mirrors the close control so the title centers on the screen.
  balance: {
    width: BAR_HEIGHT,
  },
}));
