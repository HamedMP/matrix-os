import { Tabs } from "expo-router";
import { View, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useGateway } from "../_layout";
import { colors, fonts } from "@/lib/theme";

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const iconMap: Record<string, { outline: keyof typeof Ionicons.glyphMap; filled: keyof typeof Ionicons.glyphMap }> = {
    chat: { outline: "chatbubble-outline", filled: "chatbubble" },
    "mission-control": { outline: "grid-outline", filled: "grid" },
    settings: { outline: "settings-outline", filled: "settings" },
  };

  const icons = iconMap[name];
  if (!icons) return null;

  return (
    <Ionicons
      name={focused ? icons.filled : icons.outline}
      size={24}
      color={focused ? colors.light.primary : colors.light.mutedForeground}
    />
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
  const { connectionState } = useGateway();
  const isConnected = connectionState === "connected";

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: styles.tabBar,
        tabBarActiveTintColor: colors.light.primary,
        tabBarInactiveTintColor: colors.light.mutedForeground,
        tabBarLabelStyle: styles.tabBarLabel,
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
        }}
      />
      <Tabs.Screen
        name="mission-control"
        options={{
          title: "Mission Control",
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
    backgroundColor: "rgba(255, 255, 255, 0.95)",
    borderTopColor: colors.light.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    height: Platform.OS === "ios" ? 88 : 64,
    paddingBottom: Platform.OS === "ios" ? 28 : 8,
    paddingTop: 8,
  },
  tabBarLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 10,
    marginTop: 2,
  },
  header: {
    backgroundColor: colors.light.background,
    shadowColor: "transparent",
    elevation: 0,
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
    backgroundColor: colors.light.destructive,
  },
});
