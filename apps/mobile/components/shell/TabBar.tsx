import { useEffect, useRef, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  AgentsTabIcon,
  AppsTabIcon,
  ChatsTabIcon,
  CountBadge,
  Icon,
  PressableScale,
  SettingsTabIcon,
  TerminalTabIcon,
  type IconData,
} from "@/components/ui";
import { selectHaptic } from "@/lib/haptics";
import { motion } from "@/lib/theme-v2";
import { useReduceMotion } from "@/lib/use-reduce-motion";

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

/** Where a tab sits in the bar. */
interface TabBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function sameBox(a: TabBox | undefined, b: TabBox) {
  return a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * The fill behind the active tab. It slides from tab to tab instead of
 * jumping, unless the person has asked for reduced motion.
 */
function TabHighlight({ box }: { box: TabBox }) {
  const reduceMotion = useReduceMotion();
  // Starts where it belongs: it is only drawn once its tab has been measured.
  const x = useSharedValue(box.x);
  const width = useSharedValue(box.width);
  const placed = useRef(false);

  useEffect(() => {
    if (!placed.current) {
      placed.current = true;
      return;
    }
    if (reduceMotion) {
      x.set(box.x);
      width.set(box.width);
      return;
    }
    x.set(withSpring(box.x, motion.spring.gentle));
    width.set(withSpring(box.width, motion.spring.gentle));
  }, [box, reduceMotion, width, x]);

  const animatedStyle = useAnimatedStyle(() => ({
    width: width.get(),
    transform: [{ translateX: x.get() }],
  }));

  return (
    <Animated.View
      testID="tab-highlight"
      pointerEvents="none"
      style={[styles.highlight, { top: box.y, height: box.height }, animatedStyle]}
    />
  );
}

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
  // Five entries at most, one per tab.
  const [boxes, setBoxes] = useState<Partial<Record<TabRoute, TabBox>>>({});
  const activeBox = boxes[activeRoute as TabRoute];

  const measure = (route: TabRoute) => (event: LayoutChangeEvent) => {
    const { x, y, width, height } = event.nativeEvent.layout;
    const box = { x, y, width, height };
    setBoxes((current) => (sameBox(current[route], box) ? current : { ...current, [route]: box }));
  };

  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      style={[styles.bar, { paddingBottom: insets.bottom }]}
    >
      {activeBox ? <TabHighlight box={activeBox} /> : null}
      {TABS.map((tab) => {
        const active = tab.route === activeRoute;
        const badgeCount = tab.route === BADGED_TAB ? agentsBadgeCount : 0;
        return (
          <PressableScale
            key={tab.route}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={badgeCount > 0 ? `${tab.label}, ${badgeCount} waiting` : tab.label}
            onLayout={measure(tab.route)}
            onPress={() => {
              if (!active) selectHaptic();
              onTabPress(tab.route);
            }}
            onLongPress={onTabLongPress ? () => onTabLongPress(tab.route) : undefined}
            // Until the highlight can be placed, the active tab carries the fill itself.
            style={[styles.tab, active && !activeBox && styles.tabActive]}
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
          </PressableScale>
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
  highlight: {
    position: "absolute",
    left: 0,
    borderRadius: theme.v2.radius.badge,
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
}));
