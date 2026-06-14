import { Tabs } from "expo-router";
import { View, StyleSheet } from "react-native";
import { BlurView } from "expo-blur";
import { Ionicons } from "@expo/vector-icons";
import { useGateway } from "../_layout";
import { colors, fonts } from "@/lib/theme";

const TAB_ICONS: Record<string, { outline: keyof typeof Ionicons.glyphMap; filled: keyof typeof Ionicons.glyphMap }> = {
  chat: { outline: "chatbubble-outline", filled: "chatbubble" },
  apps: { outline: "apps-outline", filled: "apps" },
  "mission-control": { outline: "grid-outline", filled: "grid" },
  settings: { outline: "settings-outline", filled: "settings" },
};

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const icons = TAB_ICONS[name];
  if (!icons) return null;

  return (
    <View style={[styles.iconShell, focused && styles.iconShellFocused]}>
      <Ionicons
        name={focused ? icons.filled : icons.outline}
        size={20}
        color={focused ? colors.light.forest : colors.light.moss}
      />
    </View>
  );
}

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <View style={styles.headerRight}>
      <View style={[styles.dot, connected ? styles.dotConnected : styles.dotDisconnected]} />
    </View>
  );
}

export default function TabsLayout() {
  const { connectionState, unreadCount } = useGateway();
  const isConnected = connectionState === "connected";

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: styles.tabBar,
        tabBarBackground: () => (
          <BlurView tint="light" intensity={88} style={styles.tabBarBackdrop} />
        ),
        tabBarActiveTintColor: colors.light.forest,
        tabBarInactiveTintColor: colors.light.moss,
        tabBarLabelStyle: styles.tabBarLabel,
        tabBarItemStyle: styles.tabBarItem,
        headerStyle: styles.header,
        headerTintColor: colors.light.foreground,
        headerTitleStyle: styles.headerTitle,
        headerRight: () => <ConnectionDot connected={isConnected} />,
      }}
    >
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
          tabBarIcon: ({ focused }) => <TabIcon name="chat" focused={focused} />,
          tabBarBadge: unreadCount > 0 ? unreadCount : undefined,
          tabBarBadgeStyle: unreadCount > 0 ? styles.badge : undefined,
        }}
      />
      <Tabs.Screen
        name="apps"
        options={{
          title: "Apps",
          tabBarIcon: ({ focused }) => <TabIcon name="apps" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="mission-control"
        options={{
          title: "Tasks",
          tabBarIcon: ({ focused }) => <TabIcon name="mission-control" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ focused }) => <TabIcon name="settings" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: "absolute" as const,
    left: 14,
    right: 14,
    bottom: process.env.EXPO_OS === "ios" ? 12 : 10,
    height: process.env.EXPO_OS === "ios" ? 78 : 66,
    paddingTop: 8,
    paddingBottom: process.env.EXPO_OS === "ios" ? 18 : 8,
    borderTopWidth: 0,
    borderRadius: 26,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: "rgba(50, 61, 46, 0.10)",
    backgroundColor: "rgba(250, 250, 249, 0.86)",
    overflow: "hidden",
    boxShadow: "0 14px 34px rgba(50, 61, 46, 0.16)",
  },
  tabBarBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(250, 250, 249, 0.78)",
  },
  tabBarItem: {
    borderRadius: 20,
    borderCurve: "continuous" as const,
  },
  tabBarLabel: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 11,
    marginTop: 0,
  },
  iconShell: {
    width: 40,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  iconShellFocused: {
    backgroundColor: "rgba(154, 164, 140, 0.24)",
    borderWidth: 1,
    borderColor: "rgba(50, 61, 46, 0.08)",
  },
  header: {
    backgroundColor: colors.light.background,
    boxShadow: "none",
  },
  headerTitle: {
    fontFamily: fonts.sansSemiBold,
    color: colors.light.foreground,
  },
  headerRight: {
    marginRight: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotConnected: {
    backgroundColor: colors.light.success,
  },
  dotDisconnected: {
    backgroundColor: colors.light.moss,
  },
  badge: {
    backgroundColor: colors.light.forest,
    color: colors.light.background,
    fontSize: 10,
    minWidth: 18,
    height: 18,
    lineHeight: 18,
  },
});
