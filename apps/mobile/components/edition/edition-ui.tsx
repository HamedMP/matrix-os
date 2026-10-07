import React from "react";
import { Pressable, Text, type ViewStyle } from "react-native";
import { styles } from "./edition-styles";
export function EditionButton({
  label,
  onPress,
  disabled,
  primary,
  style,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary && styles.primary,
        disabled && styles.disabled,
        style,
      ]}
    >
      <Text style={[styles.buttonText, primary && styles.white]}>{label}</Text>
    </Pressable>
  );
}
