import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface CountBadgeProps {
  count: number;
  /** Adds a ring in the background colour, for a badge that overlaps an icon. */
  bordered?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

/** A count in a pill. Renders nothing when there is nothing to count. */
export function CountBadge({ count, bordered = false, accessibilityLabel, testID }: CountBadgeProps) {
  if (count <= 0) return null;

  return (
    <View
      testID={testID}
      accessible={accessibilityLabel ? true : undefined}
      accessibilityLabel={accessibilityLabel}
      style={[styles.badge, bordered && styles.bordered]}
    >
      <Text style={styles.count}>{count}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    height: theme.v2.size.badge,
    minWidth: theme.v2.size.badge,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.v2.radius.full,
    paddingHorizontal: theme.v2.space[4],
    backgroundColor: theme.v2.colors.highlight,
  },
  // The ring sits outside the pill, so the pill itself stays the same size.
  bordered: {
    height: theme.v2.size.badge + theme.v2.borderWidth.emphasis * 2,
    minWidth: theme.v2.size.badge + theme.v2.borderWidth.emphasis * 2,
    borderWidth: theme.v2.borderWidth.emphasis,
    borderColor: theme.v2.colors.background,
  },
  count: {
    ...theme.v2.text.microSemiBold,
    color: theme.v2.colors.textInverse,
  },
}));
