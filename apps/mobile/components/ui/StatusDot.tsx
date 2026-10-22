import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export type StatusTone = "waiting" | "active";

export interface StatusDotProps {
  tone: StatusTone;
  /** Without a label the dot is decorative and hidden from assistive technology. */
  accessibilityLabel?: string;
  testID?: string;
}

export function StatusDot({ tone, accessibilityLabel, testID }: StatusDotProps) {
  const labelled = Boolean(accessibilityLabel);

  return (
    <View
      testID={testID}
      accessible={labelled}
      accessibilityRole={labelled ? "image" : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={!labelled}
      importantForAccessibility={labelled ? "yes" : "no-hide-descendants"}
      style={[styles.dot, styles[tone]]}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: theme.v2.size.statusDot,
    height: theme.v2.size.statusDot,
    borderRadius: theme.v2.radius.full,
  },
  waiting: {
    backgroundColor: theme.v2.colors.highlight,
  },
  active: {
    backgroundColor: theme.v2.colors.success,
  },
}));
