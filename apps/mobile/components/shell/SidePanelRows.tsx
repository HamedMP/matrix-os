import { useEffect, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { CanonicalChatRecord } from "@matrix-os/contracts";

import { ChatContextMenu } from "@/components/ChatContextMenu";
import {
  ChatIcon,
  ChevronRightIcon,
  Icon,
  IconTile,
  ItemRow,
  StatusDot,
  type IconData,
  type IconTileSize,
} from "@/components/ui";
import { PRESSED_OPACITY } from "@/components/ui/pressable-state";
import { formatRelativeTime } from "@/lib/relative-time";
import { chatActivityAt } from "@/lib/requests/canonical-chat";
import { chatNeedsUser } from "@/lib/side-panel-chats";

const CHAT_TILE_SIZE = 40 satisfies IconTileSize;
const SKELETON_TEXT_WIDTHS = ["72%", "58%", "66%"] as const;

interface SidePanelChatRowProps {
  record: CanonicalChatRecord;
  /** The time the row is dated against; the time of the render when omitted. */
  now?: Date;
  onSelect: (chatId: string) => void;
}

/** One chat: its title, last message and last activity. A long press opens the chat menu. */
export function SidePanelChatRow({ record, now, onSelect }: SidePanelChatRowProps) {
  const { chat } = record;
  const title = chat.title.trim() || "New chat";
  const preview = chat.lastMessagePreview?.replace(/\s+/g, " ").trim() || undefined;
  const time = formatRelativeTime(chatActivityAt(record), now) || undefined;
  const needsUser = chatNeedsUser(record);

  return (
    <ChatContextMenu chatId={chat.id}>
      <ItemRow
        testID={`side-panel-chat-${chat.id}`}
        density="compact"
        leading={<IconTile icon={ChatIcon} size={CHAT_TILE_SIZE} shape="circle" tone="subtle" />}
        title={title}
        titleAccessory={needsUser ? <StatusDot testID="side-panel-waiting-dot" tone="waiting" /> : undefined}
        subtitle={preview}
        meta={time}
        accessibilityLabel={[title, needsUser ? "needs you" : undefined, preview, time].filter(Boolean).join(", ")}
        onPress={() => onSelect(chat.id)}
      />
    </ChatContextMenu>
  );
}

interface SidePanelNavRowProps {
  icon: IconData;
  label: string;
  accessibilityLabel: string;
  /** Shown before the chevron, such as a count. */
  detail?: ReactNode;
  onPress: () => void;
  testID?: string;
}

/** A card-coloured row that opens another screen. */
export function SidePanelNavRow({ icon, label, accessibilityLabel, detail, onPress, testID }: SidePanelNavRowProps) {
  const { theme } = useUnistyles();

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
    >
      <Icon icon={icon} size={20} color={theme.v2.colors.textDefault} />
      <Text numberOfLines={1} style={styles.navLabel}>{label}</Text>
      {detail}
      <Icon icon={ChevronRightIcon} size={16} color={theme.v2.colors.textSubtle} />
    </Pressable>
  );
}

/** The count beside a destination's name. */
export function SidePanelNavCount({ children }: { children: number }) {
  return <Text style={styles.navCount}>{children}</Text>;
}

/** Stand-ins for chat rows while chats or search results load. */
export function SidePanelSkeletonRows() {
  const opacity = useSharedValue(0.45);

  useEffect(() => {
    opacity.set(withRepeat(withTiming(0.9, { duration: 700 }), -1, true));
    return () => cancelAnimation(opacity);
  }, [opacity]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={animatedStyle}
    >
      <View testID="recent-chat-skeleton" style={styles.skeletonRows}>
        {SKELETON_TEXT_WIDTHS.map((width) => (
          <View key={width} testID="recent-chat-skeleton-row" style={styles.skeletonRow}>
            <View style={styles.skeletonIcon} />
            <View style={[styles.skeletonText, { width }]} />
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[12],
    padding: theme.v2.space[12],
    borderRadius: theme.v2.radius.card,
    backgroundColor: theme.v2.colors.card,
  },
  navLabel: {
    ...theme.v2.text.bodyMedium,
    flex: 1,
    color: theme.v2.colors.textDefault,
  },
  navCount: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textTertiary,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
  skeletonRows: {
    gap: theme.v2.space[4],
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[12],
    paddingVertical: theme.v2.space[10],
  },
  skeletonIcon: {
    width: CHAT_TILE_SIZE,
    height: CHAT_TILE_SIZE,
    borderRadius: theme.v2.radius.full,
    backgroundColor: theme.v2.colors.accentSurface,
  },
  skeletonText: {
    height: theme.v2.text.label.fontSize,
    borderRadius: theme.v2.radius.full,
    backgroundColor: theme.v2.colors.accentSurface,
  },
}));
