import { Fragment, useEffect, useState } from "react";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import ComputerTerminal01Icon from "@hugeicons/core-free-icons/ComputerTerminal01Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import GridViewIcon from "@hugeicons/core-free-icons/GridViewIcon";
import Message01Icon from "@hugeicons/core-free-icons/Message01Icon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import PuzzleIcon from "@hugeicons/core-free-icons/PuzzleIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import Settings02Icon from "@hugeicons/core-free-icons/Settings02Icon";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { DrawerContentScrollView, type DrawerContentComponentProps } from "expo-router/drawer";

import type { CanonicalChatRecord } from "@matrix-os/contracts";

import { Icon, IconButton, Spacer, Text, type IconData } from "@/components/ui";
import type { ProjectSummary } from "@/lib/requests";

const primaryItems: Array<{ route: string; label: string; icon: IconData }> = [
  { route: "files", label: "Files", icon: Folder01Icon },
  { route: "terminal", label: "Terminal", icon: ComputerTerminal01Icon },
  { route: "integrations", label: "Integrations", icon: PuzzleIcon },
  { route: "apps", label: "Apps", icon: GridViewIcon },
];

interface MockDrawerContentProps extends DrawerContentComponentProps {
  computerName: string;
  recentChats: CanonicalChatRecord[];
  recentChatsLoading: boolean;
  projects: ProjectSummary[];
  activeSessionId: string | null;
  onSelectConversation: (id: string) => void;
  /** Pass a projectId to start the new chat pre-scoped to that Project. */
  onNewConversation: (projectId?: string | null) => void;
}

export function MockDrawerContent({
  computerName,
  recentChats,
  recentChatsLoading,
  projects,
  activeSessionId,
  onSelectConversation,
  onNewConversation,
  ...props
}: MockDrawerContentProps) {
  // Accordion-style (one open at a time) rather than desktop's independent
  // expand/collapse per project -- simpler to scan on a small screen.
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const { theme } = useUnistyles();

  function navigate(route: string) {
    props.navigation.navigate(route);
    props.navigation.closeDrawer();
  }

  function openChat(id: string) {
    onSelectConversation(id);
    navigate("index");
  }

  function newChat(projectId?: string | null) {
    onNewConversation(projectId);
    navigate("index");
  }

  // A chat only reads as "active" while the user is actually looking at the
  // chat screen -- activeSessionId otherwise stays set (it's session state,
  // not screen state) even after navigating to Files/Terminal/Settings, which
  // would highlight a chat that isn't actually on screen.
  const isOnChatScreen = props.state.routeNames[props.state.index] === "index";
  const unassignedChats = recentChats.filter((record) => !record.projectId);

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
            <Icon icon={Search01Icon} size={24} color={theme.v2.appColors.ink} />
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

        {projects.length > 0 ? (
          <>
            <Spacer size="xl" />
            <View style={styles.padded}>
              <Text size="overline" tone="subtle">Projects</Text>
            </View>
            <Spacer size="sm" />

            {projects.map((project, index) => {
              const expanded = expandedProjectId === project.id;
              const projectChats = recentChats.filter((record) => record.projectId === project.id);
              return (
                <Fragment key={project.id}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    accessibilityLabel={`${project.name} project`}
                    onPress={() => setExpandedProjectId(expanded ? null : project.id)}
                    style={({ pressed }) => [styles.padded, styles.projectRow, pressed && styles.pressed]}
                  >
                    <View style={[styles.itemContainer, styles.projectItemContainer]}>
                      <Icon icon={Folder01Icon} size={20} color={theme.v2.appColors.ink} style={styles.itemIcon} />
                      <Text size="body" numberOfLines={1}>{project.name}</Text>
                    </View>
                    <Icon
                      icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
                      size={16}
                      color={theme.v2.appColors.muted}
                    />
                  </Pressable>

                  {expanded ? (
                    <View style={styles.projectChats}>
                      {projectChats.length === 0 ? (
                        <View style={styles.padded}>
                          <Text size="muted" tone="subtle">No chats yet</Text>
                        </View>
                      ) : projectChats.map((record) => {
                        const label = record.chat.title.trim()
                          || record.chat.lastMessagePreview?.trim()
                          || "New chat";
                        const active = isOnChatScreen && record.chat.id === activeSessionId;
                        return (
                          <Pressable
                            key={record.chat.id}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            accessibilityLabel={`Open recent chat ${label}`}
                            onPress={() => openChat(record.chat.id)}
                            style={({ pressed }) => [
                              styles.padded,
                              styles.recentChatRow,
                              active && styles.recentChatRowActive,
                              pressed && styles.pressed,
                            ]}
                          >
                            <View style={styles.itemContainer}>
                              <Icon icon={Message01Icon} size={18} color={theme.v2.appColors.ink} style={styles.itemIcon} />
                              <Text size="body" numberOfLines={1}>{label}</Text>
                            </View>
                          </Pressable>
                        );
                      })}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`New chat in ${project.name}`}
                        onPress={() => newChat(project.id)}
                        style={({ pressed }) => [styles.padded, styles.recentChatRow, pressed && styles.pressed]}
                      >
                        <View style={styles.itemContainer}>
                          <Icon icon={PlusSignIcon} size={16} color={theme.v2.appColors.muted} style={styles.itemIcon} />
                          <Text size="muted" tone="subtle">New chat</Text>
                        </View>
                      </Pressable>
                    </View>
                  ) : null}
                  {index < projects.length - 1 ? <Spacer size="sm" /> : null}
                </Fragment>
              );
            })}
          </>
        ) : null}

        <Spacer size="xl" />
        <View style={styles.padded}>
          <Text size="overline" tone="subtle">Recents</Text>
        </View>
        <Spacer size="sm" />

        {recentChatsLoading ? <RecentChatsSkeleton /> : unassignedChats.length === 0 ? (
          <View style={styles.padded}>
            <Text size="muted" tone="subtle">No chats yet</Text>
          </View>
        ) : unassignedChats.map((record, index) => {
          const label = record.chat.title.trim()
            || record.chat.lastMessagePreview?.trim()
            || "New chat";
          const active = isOnChatScreen && record.chat.id === activeSessionId;
          return (
            <Fragment key={record.chat.id}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Open recent chat ${label}`}
                onPress={() => openChat(record.chat.id)}
                style={({ pressed }) => [
                  styles.padded,
                  styles.recentChatRow,
                  active && styles.recentChatRowActive,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.itemContainer}>
                  <Icon
                    icon={Message01Icon}
                    size={20}
                    color={theme.v2.appColors.ink}
                    style={styles.itemIcon}
                  />
                  <Text size="body" numberOfLines={1}>{label}</Text>
                </View>
              </Pressable>
              {index < unassignedChats.length - 1 ? <Spacer size="sm" /> : null}
            </Fragment>
          );
        })}
      </DrawerContentScrollView>
      <Spacer size="4xl" />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New chat"
        onPress={() => newChat()}
        style={({ pressed }) => [styles.newChat, pressed && styles.pressed]}
      >
        <Spacer size="sm" />
        <View style={styles.newChatContent}>
          <Icon
            icon={PencilEdit02Icon}
            size={18}
            color={theme.v2.colors.textInverse}
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
        iconColor={theme.v2.colors.textDefault}
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

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.v2.appColors.canvas,
  },
  content: {
    backgroundColor: theme.v2.appColors.canvas,
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
  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 10,
    paddingVertical: 6,
  },
  projectItemContainer: {
    flex: 1,
    marginRight: 8,
  },
  projectChats: {
    paddingLeft: 20,
    gap: 4,
    marginTop: 4,
  },
  recentChatRow: {
    borderRadius: 10,
    paddingVertical: 6,
  },
  recentChatRowActive: {
    backgroundColor: theme.v2.appColors.soft,
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
    backgroundColor: theme.v2.appColors.soft,
  },
  skeletonText: {
    height: 14,
    borderRadius: 999,
    backgroundColor: theme.v2.appColors.soft,
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
    backgroundColor: theme.v2.palette.green[800],
    boxShadow: theme.v2.designShadows.lg,
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
    borderColor: theme.v2.colors.borderSubtle,
    borderRadius: 999,
    boxShadow: theme.v2.designShadows.lg,
  },
}));
