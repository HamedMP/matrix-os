import { View, type ViewProps } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { spacing, type SpacingSize } from "@/lib/theme";

export interface SpacerProps extends Omit<ViewProps, "children" | "style"> {
  size?: SpacingSize;
}

/** The only primitive used to create vertical space in product screen stacks. */
export function Spacer({ size = "lg", ...props }: SpacerProps) {
  return (
    <View
      {...props}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.base, { height: spacing[size] }]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    alignSelf: "stretch",
    flexShrink: 0,
  },
});
