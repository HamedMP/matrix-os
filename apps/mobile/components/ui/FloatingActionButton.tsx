import { StyleSheet } from "react-native";

import { designShadows, palette, semanticColors } from "@/lib/theme";
import { IconButton, type IconButtonProps } from "./IconButton";

export interface FloatingActionButtonProps
  extends Omit<IconButtonProps, "buttonSize" | "borderRadius"> {
  accessibilityLabel: string;
  size?: number;
  rightInset?: number;
  bottomInset?: number;
}

/** Circular, elevated action anchored over a screen's content. */
export function FloatingActionButton({
  size = 48,
  iconSize = 23,
  iconColor = semanticColors.textInverse,
  backgroundColor = palette.green[800],
  rightInset = 20,
  bottomInset = 24,
  style,
  ...props
}: FloatingActionButtonProps) {
  return (
    <IconButton
      {...props}
      iconSize={iconSize}
      iconColor={iconColor}
      buttonSize={size}
      borderRadius={999}
      backgroundColor={backgroundColor}
      style={[
        styles.button,
        { right: rightInset, bottom: bottomInset },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  button: {
    position: "absolute",
    zIndex: 1,
    borderWidth: 1,
    borderColor: semanticColors.borderSubtle,
    boxShadow: designShadows.lgShine,
  },
});
