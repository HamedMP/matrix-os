import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";

interface TerminalUrlBannerProps {
  url: string;
  /** https URLs open in the browser on tap; others fall back to copy. */
  openable: boolean;
  onOpen: () => void;
  onCopy: () => void;
  onDismiss: () => void;
}

/**
 * One-line banner surfacing the most recent URL seen in terminal output (dev
 * servers, auth links). Tap opens https URLs; a copy icon or long-press copies;
 * the x dismisses. Nothing is opened automatically.
 */
export function TerminalUrlBanner({ url, openable, onOpen, onCopy, onDismiss }: TerminalUrlBannerProps) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.banner}>
      <Pressable
        style={styles.linkPress}
        accessibilityRole="link"
        accessibilityLabel={openable ? `Open ${url}` : `Copy ${url}`}
        onPress={openable ? onOpen : onCopy}
        onLongPress={onCopy}
      >
        <Ionicons name="link-outline" size={15} color={theme.terminal.brightCyan} />
        <Text style={styles.linkText} numberOfLines={1} ellipsizeMode="middle">
          {url}
        </Text>
      </Pressable>
      <Pressable
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel="Copy link"
        hitSlop={8}
        onPress={onCopy}
      >
        <Ionicons name="copy-outline" size={16} color={theme.terminal.fgDim} />
      </Pressable>
      <Pressable
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel="Dismiss link"
        hitSlop={8}
        onPress={onDismiss}
      >
        <Ionicons name="close" size={16} color={theme.terminal.fgDim} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 14,
    marginBottom: 8,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 7,
    borderRadius: 10,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: theme.terminal.border,
    backgroundColor: theme.terminal.surface,
  },
  linkPress: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  linkText: {
    flex: 1,
    fontFamily: theme.fonts.mono,
    fontSize: 12.5,
    color: theme.terminal.brightCyan,
  },
  iconButton: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
}));
