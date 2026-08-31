import {
  StyleSheet,
  View,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";

import { semanticColors } from "@/lib/theme";

export interface DividerProps extends Omit<ViewProps, "style"> {
  style?: StyleProp<ViewStyle>;
}

/** Edge-to-edge horizontal rule. Callers opt into any horizontal inset. */
export function Divider({ style, ...props }: DividerProps) {
  return <View {...props} pointerEvents="none" style={[styles.divider, style]} />;
}

const styles = StyleSheet.create({
  divider: {
    alignSelf: "stretch",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semanticColors.borderSubtle,
  },
});
