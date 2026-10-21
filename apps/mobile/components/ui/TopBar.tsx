import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import type { IconData } from "./Icon";
import { IconButton } from "./IconButton";
import { DISABLED_OPACITY } from "./pressable-state";

export interface TopBarProps {
  title?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  align?: "center" | "start";
  /** Start-aligned form only: shown under the title. */
  subtitle?: string;
  /** Start-aligned form only: shown before the title. */
  titleLeading?: ReactNode;
  testID?: string;
}

/** The row at the top of a screen. The screen adds the safe-area inset above it. */
export function TopBar({
  title,
  leading,
  trailing,
  align = "center",
  subtitle,
  titleLeading,
  testID,
}: TopBarProps) {
  const centered = align === "center";
  const titleNode = title ? (
    <Text
      accessibilityRole="header"
      numberOfLines={1}
      style={[styles.title, centered && styles.titleCentered]}
    >
      {title}
    </Text>
  ) : null;

  return (
    <View testID={testID} style={[styles.bar, !centered && styles.barStart]}>
      {/* A centred title needs both slots, even empty, to stay centred. */}
      {centered || leading ? (
        <View testID={testID ? `${testID}-leading` : undefined} style={[styles.slot, styles.leadingSlot]}>
          {leading}
        </View>
      ) : null}
      {centered ? (
        titleNode ?? <View style={styles.fill} />
      ) : (
        <>
          {titleLeading}
          <View style={styles.fill}>
            {titleNode}
            {subtitle ? <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
        </>
      )}
      {centered || trailing ? (
        <View testID={testID ? `${testID}-trailing` : undefined} style={[styles.slot, styles.trailingSlot]}>
          {trailing}
        </View>
      ) : null}
    </View>
  );
}

export interface TopBarButtonProps {
  icon: IconData;
  accessibilityLabel: string;
  onPress?: () => void;
  iconSize?: number;
  /** Draws the round card-coloured ground. */
  filled?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function TopBarButton({
  icon,
  accessibilityLabel,
  onPress,
  iconSize = 20,
  filled = false,
  disabled = false,
  testID,
}: TopBarButtonProps) {
  const { theme } = useUnistyles();

  return (
    <IconButton
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      icon={icon}
      iconSize={iconSize}
      buttonSize={theme.v2.size.tapTarget}
      borderRadius={theme.v2.radius.full}
      backgroundColor={filled ? theme.v2.colors.card : "transparent"}
      disabled={disabled}
      onPress={onPress}
      style={disabled && styles.disabled}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    height: theme.v2.size.topBar,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.v2.space[8],
  },
  barStart: {
    gap: theme.v2.space[10],
  },
  slot: {
    minWidth: theme.v2.size.tapTarget,
    justifyContent: "center",
  },
  leadingSlot: {
    alignItems: "flex-start",
  },
  trailingSlot: {
    alignItems: "flex-end",
  },
  fill: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...theme.v2.text.bodySemiBold,
    color: theme.v2.colors.textDefault,
  },
  titleCentered: {
    flex: 1,
    textAlign: "center",
  },
  subtitle: {
    ...theme.v2.text.footnote,
    color: theme.v2.colors.textSubtle,
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
}));
