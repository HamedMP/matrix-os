import { useUnistyles } from "react-native-unistyles";
import { Tabs, type BottomTabBarProps } from "expo-router/tabs";

import { useAgentsWaitingCount } from "@/components/agents/use-agents-waiting-count";
import { TABS, TabBar } from "@/components/shell/TabBar";
import { focusedNestedRouteName, isTabBarHidden } from "@/lib/tab-bar-visibility";
import { useReduceMotion } from "@/lib/use-reduce-motion";

function ShellTabBar({ state, navigation }: BottomTabBarProps) {
  const agentsWaiting = useAgentsWaitingCount();
  const focused = state.routes[state.index];

  if (isTabBarHidden(focused.name, focusedNestedRouteName(focused))) return null;

  // An open keyboard covers the bar where it stands, on Android too: the app
  // is edge to edge, so the window does not shrink for the keyboard.
  return (
    <TabBar
      activeRoute={focused.name}
      agentsBadgeCount={agentsWaiting}
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
  const reduceMotion = useReduceMotion();

  return (
    <Tabs
      tabBar={(props: BottomTabBarProps) => <ShellTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: theme.v2.colors.background },
        // The next tab's screen slides in a little from its side; with reduced
        // motion it cross-fades instead.
        animation: reduceMotion ? "fade" : "shift",
      }}
    >
      {TABS.map((tab) => <Tabs.Screen key={tab.route} name={tab.route} />)}
    </Tabs>
  );
}
