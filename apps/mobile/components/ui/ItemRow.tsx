import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { motion, space, type SpaceStep } from "@/lib/theme-v2";

import { PressableScale } from "./PressableScale";
import { DISABLED_OPACITY } from "./pressable-state";

export interface ItemRowProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  /** Shown straight after the title, such as a status dot. */
  titleAccessory?: ReactNode;
  /** Short text at the top right, such as a time. */
  meta?: string;
  /** Shown right of the meta text, on its line, such as a status dot. */
  metaAccessory?: ReactNode;
  trailing?: ReactNode;
  density?: "compact" | "comfortable";
  /** Space between the leading node and the text. */
  gap?: SpaceStep;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

/** The list row for chats, agents, projects and templates. */
export function ItemRow({
  density = "compact",
  gap = 12,
  onPress,
  onLongPress,
  disabled = false,
  accessibilityLabel,
  testID,
  ...contentProps
}: ItemRowProps) {
  const content = <ItemRowContent {...contentProps} gap={gap} testID={testID} />;

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
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      pressedScale={motion.rowPressScale}
      style={[styles.row, styles[density], disabled && styles.disabled]}
    >
      {content}
    </PressableScale>
  );
}

type ItemRowContentProps = Pick<ItemRowProps,
  "title" | "subtitle" | "leading" | "titleAccessory" | "meta" | "metaAccessory" | "trailing" | "gap" | "testID"
>;

function ItemRowContent({
  title, subtitle, leading, titleAccessory, meta, metaAccessory, trailing, gap = 12, testID,
}: ItemRowContentProps) {
  return (
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
      {meta || metaAccessory ? (
        <View testID={testID ? `${testID}-meta` : undefined} style={styles.metaLine}>
          {meta ? <Text numberOfLines={1} style={styles.meta}>{meta}</Text> : null}
          {metaAccessory}
        </View>
      ) : null}
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </>
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
  disabled: {
    opacity: DISABLED_OPACITY,
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
  metaLine: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.v2.space[6],
    marginLeft: theme.v2.space[8],
  },
  meta: {
    ...theme.v2.text.footnote,
    alignSelf: "flex-start",
    color: theme.v2.colors.textTertiary,
  },
  trailing: {
    marginLeft: theme.v2.space[8],
  },
}));
