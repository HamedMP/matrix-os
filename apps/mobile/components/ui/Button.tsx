import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import type { SemanticColors } from "@/lib/theme-v2";

import { Icon, type IconData } from "./Icon";
import { DISABLED_OPACITY, PRESSED_OPACITY } from "./pressable-state";

export type ButtonVariant = "filled" | "outline" | "secondary" | "text";
export type ButtonSize = "default" | "large";

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconData;
  /** Stretches the button across a column. In a row, give it a flexible wrapper instead. */
  fullWidth?: boolean;
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

const CONTENT_COLOR = {
  filled: "onControlPrimary",
  outline: "onControl",
  secondary: "onControlSecondary",
  text: "onControl",
} as const satisfies Record<ButtonVariant, keyof SemanticColors>;

export function Button({
  label,
  onPress,
  variant = "filled",
  size = "default",
  icon,
  fullWidth = false,
  loading = false,
  disabled = false,
  accessibilityLabel,
  testID,
}: ButtonProps) {
  const { theme } = useUnistyles();
  const contentColor = theme.v2.colors[CONTENT_COLOR[variant]];
  const inactive = disabled || loading;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        styles[size],
        styles[variant],
        fullWidth && styles.fullWidth,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {/* Kept in place while loading so the button does not change width. */}
      <View
        testID={testID ? `${testID}-content` : undefined}
        style={[styles.content, loading && styles.hidden]}
      >
        {icon ? <Icon icon={icon} size={16} color={contentColor} /> : null}
        <Text numberOfLines={1} style={[styles.label, styles[`${variant}Label`]]}>
          {label}
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator size="small" color={contentColor} style={styles.spinner} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  base: {
    minWidth: theme.v2.size.tapTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.v2.radius.control,
    paddingHorizontal: theme.v2.space[10],
  },
  default: {
    height: theme.v2.size.control,
  },
  large: {
    height: theme.v2.size.controlLarge,
  },
  fullWidth: {
    alignSelf: "stretch",
  },
  filled: {
    backgroundColor: theme.v2.colors.controlPrimary,
  },
  outline: {
    backgroundColor: theme.v2.colors.controlOutline,
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.colors.controlOutlineBorder,
  },
  secondary: {
    backgroundColor: theme.v2.colors.controlSecondary,
  },
  text: {},
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
  },
  hidden: {
    opacity: 0,
  },
  spinner: {
    position: "absolute",
  },
  label: {
    ...theme.v2.text.labelMedium,
  },
  filledLabel: {
    color: theme.v2.colors.onControlPrimary,
  },
  outlineLabel: {
    color: theme.v2.colors.onControl,
  },
  secondaryLabel: {
    color: theme.v2.colors.onControlSecondary,
  },
  textLabel: {
    color: theme.v2.colors.onControl,
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
