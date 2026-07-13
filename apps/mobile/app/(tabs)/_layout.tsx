import { Tabs } from "expo-router";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { BlurView } from "expo-blur";
import { Ionicons } from "@expo/vector-icons";
import { useGateway } from "../_layout";

// Apps is the launcher home; Chat sits beside it as the always-available
// Hermes assistant surface.
export const unstable_settings = {
  initialRouteName: "apps",
};

const TAB_ICONS: Record<string, { outline: keyof typeof Ionicons.glyphMap; filled: keyof typeof Ionicons.glyphMap }> = {
  chat: { outline: "chatbubble-outline", filled: "chatbubble" },
  apps: { outline: "apps-outline", filled: "apps" },
  terminal: { outline: "terminal-outline", filled: "terminal" },
  settings: { outline: "settings-outline", filled: "settings" },
};

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const { theme } = useUnistyles();
  const icons = TAB_ICONS[name];
  if (!icons) return null;

  return (
    <View style={[styles.iconShell, focused && styles.iconShellFocused]}>
      <Ionicons
        name={focused ? icons.filled : icons.outline}
        size={20}
        color={focused ? theme.colors.forest : theme.colors.moss}
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
  const { theme } = useUnistyles();
  const { connectionState } = useGateway();
  const isConnected = connectionState === "connected";

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: styles.tabBar,
        tabBarHideOnKeyboard: true,
        tabBarBackground: () => (
          <BlurView tint="light" intensity={theme.glass.blurIntensity} style={styles.tabBarBackdrop} />
        ),
        tabBarActiveTintColor: theme.colors.forest,
        tabBarInactiveTintColor: theme.colors.moss,
        tabBarLabelStyle: styles.tabBarLabel,
        tabBarItemStyle: styles.tabBarItem,
        headerStyle: styles.header,
        headerTintColor: theme.colors.foreground,
        headerTitleStyle: styles.headerTitle,
        headerRight: () => <ConnectionDot connected={isConnected} />,
      }}
    >
      <Tabs.Screen
        name="apps"
        options={{
          title: "Apps",
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabIcon name="apps" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
          tabBarIcon: ({ focused }) => <TabIcon name="chat" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="terminal"
        options={{
          title: "Terminal",
          headerShown: false,
          // Immersive terminal — hide the floating tab bar; the in-screen header
          // back button returns to the launcher.
          tabBarStyle: { display: "none" },
          tabBarIcon: ({ focused }) => <TabIcon name="terminal" focused={focused} />,
        }}
      />
      {/* Tasks removed from the tab bar; route kept but hidden. */}
      <Tabs.Screen name="mission-control" options={{ href: null }} />
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

const styles = StyleSheet.create((theme, rt) => ({
  // Full-width frosted bar anchored to the bottom edge — no floating gaps, so the
  // paper background never peeks around it. Content scrolls under the blur.
  tabBar: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: 0,
    height: (process.env.EXPO_OS === "ios" ? 56 : 60) + rt.insets.bottom,
    paddingTop: 10,
    paddingBottom: rt.insets.bottom > 0 ? rt.insets.bottom - 4 : 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.glass.border,
    backgroundColor: theme.glass.tint,
    elevation: 0,
    boxShadow: "0 -1px 14px rgba(50, 61, 46, 0.05)",
  },
  tabBarBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.glass.tint,
  },
  tabBarItem: {
    borderRadius: 18,
    borderCurve: "continuous" as const,
  },
  tabBarLabel: {
    fontFamily: theme.fonts.sansSemiBold,
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
    backgroundColor: theme.colors.background,
    boxShadow: "none",
  },
  headerTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    color: theme.colors.foreground,
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
    backgroundColor: theme.colors.success,
  },
  dotDisconnected: {
    backgroundColor: theme.colors.moss,
  },
  badge: {
    backgroundColor: theme.colors.forest,
    color: theme.colors.background,
    fontSize: 10,
    minWidth: 18,
    height: 18,
    lineHeight: 18,
  },
}));
