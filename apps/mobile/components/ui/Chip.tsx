import type { ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { size } from "@/lib/theme-v2";

import { DISABLED_OPACITY, PRESSED_OPACITY } from "./pressable-state";

export interface ChipProps {
  label: string;
  selected?: boolean;
  leading?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

// A chip is drawn 36pt high and as narrow as 40pt, so the slop makes up the
// rest of the 44pt target. It stays within half the 8pt gap between chips.
const HIT_SLOP = (size.tapTarget - size.chip) / 2;

export function Chip({
  label,
  selected = false,
  leading,
  onPress,
  disabled = false,
  accessibilityLabel,
  testID,
}: ChipProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {leading}
      <Text numberOfLines={1} style={[styles.label, selected && styles.labelSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    height: theme.v2.size.chip,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
    borderRadius: theme.v2.radius.full,
    paddingHorizontal: theme.v2.space[12],
    backgroundColor: theme.v2.colors.chip,
  },
  chipSelected: {
    backgroundColor: theme.v2.colors.chipSelected,
  },
  label: {
    ...theme.v2.text.captionMedium,
    color: theme.v2.colors.textDefault,
  },
  labelSelected: {
    color: theme.v2.colors.onChipSelected,
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
