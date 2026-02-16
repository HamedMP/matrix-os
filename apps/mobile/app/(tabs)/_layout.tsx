import { Tabs } from "expo-router";
import { View, Text } from "react-native";
import { useGateway } from "../_layout";

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const icons: Record<string, string> = {
    chat: "M",
    "mission-control": "T",
    settings: "S",
  };
  return (
    <View
      className={`items-center justify-center rounded-lg px-3 py-1 ${
        focused ? "bg-primary/10" : ""
      }`}
    >
      <Text
        className={`font-mono text-xs font-bold ${
          focused ? "text-primary" : "text-muted-foreground"
        }`}
      >
        {icons[name] ?? "?"}
      </Text>
    </View>
  );
}

export default function TabsLayout() {
  const { connectionState } = useGateway();
  const isConnected = connectionState === "connected";

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: "#ffffff",
          borderTopColor: "#d8d0de",
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: "#c2703a",
        tabBarInactiveTintColor: "#78716c",
        tabBarLabelStyle: {
          fontFamily: "Inter_500Medium",
          fontSize: 11,
        },
        headerStyle: {
          backgroundColor: "#ece5f0",
        },
        headerTintColor: "#1c1917",
        headerTitleStyle: {
          fontFamily: "Inter_600SemiBold",
        },
        headerRight: () => (
          <View className="mr-4">
            <View
              className={`size-2 rounded-full ${isConnected ? "bg-success" : "bg-destructive"}`}
            />
          </View>
        ),
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
