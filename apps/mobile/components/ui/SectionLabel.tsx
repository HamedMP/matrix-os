import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface SectionLabelProps {
  children: string;
  testID?: string;
}

/** The small upper-cased heading above a group of rows. */
export function SectionLabel({ children, testID }: SectionLabelProps) {
  return (
    <Text testID={testID} accessibilityRole="header" style={styles.label}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    ...theme.v2.text.footnoteMedium,
    color: theme.v2.colors.textTertiary,
    textTransform: "uppercase",
  },
}));
