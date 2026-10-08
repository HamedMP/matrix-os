import { Platform } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Tabs, type BottomTabBarProps } from "expo-router/tabs";

import { TABS, TabBar } from "@/components/shell/TabBar";
import { focusedNestedRouteName, isTabBarHidden } from "@/lib/tab-bar-visibility";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";

function ShellTabBar({ state, navigation }: BottomTabBarProps) {
  const keyboardVisible = useKeyboardVisible();
  const focused = state.routes[state.index];

  if (isTabBarHidden(focused.name, focusedNestedRouteName(focused))) return null;
  // Android resizes the window for the keyboard, which would lift the bar on
  // top of it. On iOS the keyboard simply covers the bar.
  if (Platform.OS === "android" && keyboardVisible) return null;

  return (
    <TabBar
      activeRoute={focused.name}
      agentsBadgeCount={0}
      onTabPress={(name) => {
        const route = state.routes.find((candidate) => candidate.name === name);
        if (!route) return;
        // A tab's own stack listens for this to return to its first screen
        // when the tab is pressed while it is already showing.
        const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
        if (route.key !== focused.key && !event.defaultPrevented) {
          navigation.navigate(route.name, route.params);
        }
      }}
      onTabLongPress={(name) => {
        const route = state.routes.find((candidate) => candidate.name === name);
        if (route) navigation.emit({ type: "tabLongPress", target: route.key });
      }}
    />
  );
}

export default function TabsLayout() {
  const { theme } = useUnistyles();

  return (
    <Tabs
      tabBar={(props: BottomTabBarProps) => <ShellTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: theme.v2.colors.background },
      }}
    >
      {TABS.map((tab) => <Tabs.Screen key={tab.route} name={tab.route} />)}
    </Tabs>
  );
}
