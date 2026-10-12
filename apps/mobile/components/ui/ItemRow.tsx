import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { space, type SpaceStep } from "@/lib/theme-v2";

import { PRESSED_OPACITY } from "./pressable-state";

export interface ItemRowProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  /** Shown straight after the title, such as a status dot. */
  titleAccessory?: ReactNode;
  /** Short text at the top right, such as a time. */
  meta?: string;
  trailing?: ReactNode;
  density?: "compact" | "comfortable";
  /** Space between the leading node and the text. */
  gap?: SpaceStep;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
}

/** The list row for chats, agents, projects and templates. */
export function ItemRow({
  title,
  subtitle,
  leading,
  titleAccessory,
  meta,
  trailing,
  density = "compact",
  gap = 12,
  onPress,
  onLongPress,
  accessibilityLabel,
  testID,
}: ItemRowProps) {
  const content = (
    <>
      {leading ? (
        <View
          testID={testID ? `${testID}-leading` : undefined}
          style={{ marginRight: space[gap] }}
        >
          {leading}
        </View>
      ) : null}
      <View style={styles.text}>
        <View testID={testID ? `${testID}-title-line` : undefined} style={styles.titleLine}>
          <Text numberOfLines={1} style={styles.title}>{title}</Text>
          {titleAccessory}
        </View>
        {subtitle ? <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {meta ? <Text numberOfLines={1} style={styles.meta}>{meta}</Text> : null}
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </>
  );

  if (!onPress && !onLongPress) {
    return (
      <View testID={testID} accessibilityLabel={accessibilityLabel} style={[styles.row, styles[density]]}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, styles[density], pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  compact: {
    paddingVertical: theme.v2.space[10],
  },
  comfortable: {
    paddingVertical: theme.v2.space[12],
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
  },
  title: {
    ...theme.v2.text.bodyMedium,
    flexShrink: 1,
    color: theme.v2.colors.textDefault,
  },
  subtitle: {
    ...theme.v2.text.caption,
    marginTop: theme.v2.space[2],
    color: theme.v2.colors.textSubtle,
  },
  meta: {
    ...theme.v2.text.footnote,
    alignSelf: "flex-start",
    marginLeft: theme.v2.space[8],
    color: theme.v2.colors.textTertiary,
  },
  trailing: {
    marginLeft: theme.v2.space[8],
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
