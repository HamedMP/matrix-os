import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  AgentsTabIcon,
  AppsTabIcon,
  ChatsTabIcon,
  CountBadge,
  Icon,
  SettingsTabIcon,
  TerminalTabIcon,
  type IconData,
} from "@/components/ui";
import { PRESSED_OPACITY } from "@/components/ui/pressable-state";

/** The tabs in the order they are drawn. `route` is the tab's route under `app/(drawer)/(tabs)/`. */
export const TABS = [
  { route: "(chats)", label: "Chats", icon: ChatsTabIcon },
  { route: "agents", label: "Agents", icon: AgentsTabIcon },
  { route: "(apps)", label: "Apps", icon: AppsTabIcon },
  { route: "terminal", label: "Terminal", icon: TerminalTabIcon },
  { route: "settings", label: "Settings", icon: SettingsTabIcon },
] as const satisfies readonly { route: string; label: string; icon: IconData }[];

export type TabRoute = (typeof TABS)[number]["route"];

const BADGED_TAB: TabRoute = "agents";

export interface TabBarProps {
  /** Route of the tab on screen. */
  activeRoute: string;
  onTabPress: (route: TabRoute) => void;
  onTabLongPress?: (route: TabRoute) => void;
  /** How many agents are waiting on the person. Shown on the Agents tab above zero. */
  agentsBadgeCount?: number;
  testID?: string;
}

/** The app's primary navigation. Sits at the bottom of the screen, over the home indicator. */
export function TabBar({
  activeRoute,
  onTabPress,
  onTabLongPress,
  agentsBadgeCount = 0,
  testID,
}: TabBarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();

  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      style={[styles.bar, { paddingBottom: insets.bottom }]}
    >
      {TABS.map((tab) => {
        const active = tab.route === activeRoute;
        const badgeCount = tab.route === BADGED_TAB ? agentsBadgeCount : 0;
        return (
          <Pressable
            key={tab.route}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={badgeCount > 0 ? `${tab.label}, ${badgeCount} waiting` : tab.label}
            onPress={() => onTabPress(tab.route)}
            onLongPress={onTabLongPress ? () => onTabLongPress(tab.route) : undefined}
            style={({ pressed }) => [styles.tab, active && styles.tabActive, pressed && styles.pressed]}
          >
            <View style={styles.iconBox}>
              <Icon
                icon={tab.icon}
                size={theme.v2.size.tabIcon}
                color={active ? theme.v2.colors.textDefault : theme.v2.colors.textSubtle}
              />
              {badgeCount > 0 ? (
                <View testID={`tab-badge-${tab.route}`} style={styles.badge}>
                  <CountBadge bordered count={badgeCount} testID={`tab-badge-${tab.route}-count`} />
                </View>
              ) : null}
            </View>
            <Text numberOfLines={1} style={[styles.label, active && styles.labelActive]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: theme.v2.space[8],
    paddingHorizontal: theme.v2.space[12],
    borderTopWidth: theme.v2.borderWidth.hairline,
    borderTopColor: theme.v2.colors.borderHairline,
    backgroundColor: theme.v2.colors.background,
  },
  // Five tabs fit a 375pt screen at full width; on anything narrower they give
  // up width evenly instead of running off the edge.
  tab: {
    width: theme.v2.size.tabItemWidth,
    flexShrink: 1,
    minHeight: theme.v2.size.tapTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.v2.radius.badge,
  },
  tabActive: {
    backgroundColor: theme.v2.colors.card,
  },
  iconBox: {
    paddingHorizontal: theme.v2.space[14],
    paddingVertical: theme.v2.space[2],
    marginBottom: theme.v2.space[4],
  },
  // Overlaps the icon's top right corner.
  badge: {
    position: "absolute",
    top: -theme.v2.space[2],
    right: theme.v2.space[4],
  },
  label: {
    ...theme.v2.text.micro,
    color: theme.v2.colors.textSubtle,
  },
  labelActive: {
    ...theme.v2.text.microSemiBold,
    color: theme.v2.colors.textDefault,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
