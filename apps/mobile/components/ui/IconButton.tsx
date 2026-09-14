import type { ComponentProps } from "react";
import {
  ActivityIndicator,
  Pressable,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Icon, type IconData } from "./Icon";

export interface IconButtonProps
  extends Omit<ComponentProps<typeof Pressable>, "children" | "style"> {
  icon: IconData;
  iconColor?: ColorValue;
  iconSize?: number;
  iconTestID?: string;
  loading?: boolean;
  loadingTestID?: string;
  spinnerColor?: ColorValue;
  backgroundColor?: ColorValue;
  buttonSize?: number;
  borderRadius?: number;
  pressedOpacity?: number;
  style?: StyleProp<ViewStyle>;
}

/** Icon-only control. Its surface is transparent unless a background is provided. */
export function IconButton({
  icon,
  iconColor,
  iconSize = 20,
  iconTestID,
  loading = false,
  loadingTestID,
  spinnerColor,
  backgroundColor = "transparent",
  buttonSize = 40,
  borderRadius = 15,
  pressedOpacity = 0.65,
  style,
  ...pressableProps
}: IconButtonProps) {
  const { theme } = useUnistyles();
  const resolvedIconColor = iconColor ?? theme.v2.colors.textDefault;
  const disabled = Boolean(pressableProps.disabled || loading);

  return (
    <Pressable
      {...pressableProps}
      accessibilityRole={pressableProps.accessibilityRole ?? "button"}
      accessibilityState={{
        ...pressableProps.accessibilityState,
        busy: loading || pressableProps.accessibilityState?.busy,
        disabled,
      }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          width: buttonSize,
          height: buttonSize,
          borderRadius,
          backgroundColor,
        },
        style,
        pressed && { opacity: pressedOpacity },
      ]}
    >
      {loading ? (
        <ActivityIndicator
          testID={loadingTestID}
          size="small"
          color={spinnerColor ?? resolvedIconColor}
        />
      ) : (
        <Icon testID={iconTestID} icon={icon} size={iconSize} color={resolvedIconColor} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
  },
});
