import { Fragment, useEffect } from "react";
import ComputerTerminal01Icon from "@hugeicons/core-free-icons/ComputerTerminal01Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import GridViewIcon from "@hugeicons/core-free-icons/GridViewIcon";
import Message01Icon from "@hugeicons/core-free-icons/Message01Icon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import PuzzleIcon from "@hugeicons/core-free-icons/PuzzleIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import Settings02Icon from "@hugeicons/core-free-icons/Settings02Icon";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { DrawerContentScrollView, type DrawerContentComponentProps } from "expo-router/drawer";

import { Icon, IconButton, Spacer, Text, type IconData } from "@/components/ui";
import type { ConversationSummary } from "@/lib/requests";
import { designShadows, palette, semanticColors } from "@/lib/theme";
import { mockColors } from "./theme";

const primaryItems: Array<{ route: string; label: string; icon: IconData }> = [
  { route: "files", label: "Files", icon: Folder01Icon },
  { route: "terminal", label: "Terminal", icon: ComputerTerminal01Icon },
  { route: "integrations", label: "Integrations", icon: PuzzleIcon },
  { route: "apps", label: "Apps", icon: GridViewIcon },
];

interface MockDrawerContentProps extends DrawerContentComponentProps {
  computerName: string;
  recentChats: ConversationSummary[];
  recentChatsLoading: boolean;
}

export function MockDrawerContent({
  computerName,
  recentChats,
  recentChatsLoading,
  ...props
}: MockDrawerContentProps) {
  function navigate(route: string) {
    props.navigation.navigate(route);
    props.navigation.closeDrawer();
  }

  return (
    <View style={styles.root}>
      <DrawerContentScrollView {...props} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open Matrix OS home"
            hitSlop={8}
            onPress={() => navigate("index")}
            style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
          >
            <Text size="large">Matrix OS</Text>
            <Spacer size="xs" />
            <Text size="muted" tone="subtle">{computerName}</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search"
            hitSlop={10}
            onPress={() => navigate("search")}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Icon icon={Search01Icon} size={24} color={mockColors.ink} />
          </Pressable>
        </View>

        <Spacer size="xl" />

        {primaryItems.map((item, index) => {
          return (
            <Fragment key={item.route}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={item.label}
                onPress={() => navigate(item.route)}
                style={({ pressed }) => [
                  styles.padded,
                  pressed && styles.pressed,
                ]}
              >
                <Spacer size="xxs" />
                <View style={styles.itemContainer}>
                  <Icon
                    icon={item.icon}
                    size={20}
                    style={styles.itemIcon}
                  />
                  <Text size="body">{item.label}</Text>
                </View>
                <Spacer size="xxs" />
              </Pressable>
              {index < primaryItems.length - 1 ? <Spacer size="sm" /> : null}
            </Fragment>
          );
        })}

        <Spacer size="xl" />
        <View style={styles.padded}>
          <Text size="overline" tone="subtle">Recents</Text>
        </View>
        <Spacer size="sm" />

        {recentChatsLoading ? <RecentChatsSkeleton /> : recentChats.map((chat, index) => {
          const label = chat.preview.trim() || "New chat";
          return (
            <Fragment key={chat.id}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open recent chat ${label}`}
                onPress={() => navigate("index")}
                style={({ pressed }) => [styles.padded, pressed && styles.pressed]}
              >
                <View style={styles.itemContainer}>
                  <Icon
                    icon={Message01Icon}
                    size={20}
                    color={mockColors.ink}
                    style={styles.itemIcon}
                  />
                  <Text size="body" numberOfLines={1}>{label}</Text>
                </View>
              </Pressable>
              {index < recentChats.length - 1 ? <Spacer size="sm" /> : null}
            </Fragment>
          );
        })}
      </DrawerContentScrollView>
      <Spacer size="4xl" />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New chat"
        onPress={() => navigate("index")}
        style={({ pressed }) => [styles.newChat, pressed && styles.pressed]}
      >
        <Spacer size="sm" />
        <View style={styles.newChatContent}>
          <Icon
            icon={PencilEdit02Icon}
            size={18}
            color={semanticColors.textInverse}
            style={styles.newChatIcon}
            testID="new-chat-icon"
          />
          <Text size="body" tone="inverse">New chat</Text>
        </View>
        <Spacer size="sm" />
      </Pressable>

      <IconButton
        accessibilityLabel="Settings"
        icon={Settings02Icon}
        iconSize={22}
        iconColor={semanticColors.textDefault}
        iconTestID="settings-icon"
        buttonSize={40}
        style={styles.settingsButton}
        onPress={() => navigate("settings")}
      />
    </View>
  );
}

function RecentChatsSkeleton() {
  const opacity = useSharedValue(0.45);

  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.9, { duration: 700 }), -1, true);
    return () => cancelAnimation(opacity);
  }, [opacity]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={animatedStyle}
    >
      {(["72%", "58%", "66%"] as const).map((width, index, rows) => (
        <Fragment key={width}>
          <View testID="recent-chat-skeleton-row" style={[styles.padded, styles.skeletonRow]}>
            <View style={styles.skeletonIcon} />
            <View style={[styles.skeletonText, { width }]} />
          </View>
          {index < rows.length - 1 ? <Spacer size="sm" /> : null}
        </Fragment>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: mockColors.canvas,
  },
  content: {
    backgroundColor: mockColors.canvas,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  identity: {
    flex: 1,
  },
  padded: {
    paddingHorizontal: 8,
  },
  itemContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  itemIcon: {
    marginRight: 8,
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  skeletonIcon: {
    width: 20,
    height: 20,
    marginRight: 16,
    borderRadius: 999,
    backgroundColor: palette.neutral[200],
  },
  skeletonText: {
    height: 14,
    borderRadius: 999,
    backgroundColor: palette.neutral[200],
  },
  pressed: {
    opacity: 0.65,
  },
  newChat: {
    position: "absolute",
    left: 16,
    bottom: 24,
    borderRadius: 999,
    paddingHorizontal: 16,
    backgroundColor: palette.green[800],
    boxShadow: designShadows.lg,
  },
  newChatContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  newChatIcon: {
    marginRight: 8,
  },
  settingsButton: {
    position: "absolute",
    right: 16,
    bottom: 26,
    borderWidth: 1,
    borderColor: semanticColors.borderSubtle,
    borderRadius: 999,
    boxShadow: designShadows.lg,
  },
});
