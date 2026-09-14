import { StyleSheet, useUnistyles } from "react-native-unistyles";

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
  iconColor,
  backgroundColor,
  rightInset = 20,
  bottomInset = 24,
  style,
  ...props
}: FloatingActionButtonProps) {
  const { theme } = useUnistyles();

  return (
    <IconButton
      {...props}
      iconSize={iconSize}
      iconColor={iconColor ?? theme.v2.colors.textInverse}
      buttonSize={size}
      borderRadius={999}
      backgroundColor={backgroundColor ?? theme.v2.palette.green[800]}
      style={[
        styles.button,
        { right: rightInset, bottom: bottomInset },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    position: "absolute",
    zIndex: 1,
    borderWidth: 1,
    borderColor: theme.v2.colors.borderSubtle,
    boxShadow: theme.v2.designShadows.lgShine,
  },
}));
