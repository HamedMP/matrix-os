import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { motion, space, type SpaceStep } from "@/lib/theme-v2";

import { PressableScale } from "./PressableScale";

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
      <View testID={testID ? `${testID}-text` : undefined} style={styles.text}>
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
    <PressableScale
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      pressedScale={motion.rowPressScale}
      style={[styles.row, styles[density]]}
    >
      {content}
    </PressableScale>
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
    // Spelled out because a row hosted in the iOS chat menu is laid out on
    // its own, where a column that may only grow keeps its text's full width.
    flexShrink: 1,
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
}));
